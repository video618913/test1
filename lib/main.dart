import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';

const MethodChannel _smsChannel = MethodChannel('com.example.paygate/sms');

// ─── Constants ────────────────────────────────────────────────────────────────
const String kWorkerUrl = 'worker_url';
const String kApiKey = 'api_key';
const String kEnabled = 'sms_forward_enabled';
const String kForwardCount = 'forward_count';
const String kLastLog = 'last_log';
const String kSetupDone = 'setup_done';

const Color kPrimary = Color(0xFFE2136E);
const Color kBg = Color(0xFF0F0F0F);
const Color kCard = Color(0xFF1A1A1A);
const Color kBorder = Color(0xFF2A2A2A);
const Color kMuted = Color(0xFF888888);
const Color kSuccess = Color(0xFF22C55E);
const Color kDanger = Color(0xFFEF4444);
const Color kWarning = Color(0xFFF59E0B);

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
  ));
  final prefs = await SharedPreferences.getInstance();
  final setupDone = prefs.getBool(kSetupDone) ?? false;
  runApp(PayGateApp(setupDone: setupDone));
}

// ─── App Root ─────────────────────────────────────────────────────────────────
class PayGateApp extends StatelessWidget {
  final bool setupDone;
  const PayGateApp({super.key, required this.setupDone});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PayGate SMS',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: kBg,
        fontFamily: 'sans-serif',
        colorScheme: const ColorScheme.dark(primary: kPrimary, surface: kCard),
      ),
      home: setupDone ? const HomeScreen() : const SetupScreen(),
    );
  }
}

// ─── Setup Screen ─────────────────────────────────────────────────────────────
class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key});
  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _urlCtrl = TextEditingController();
  final _keyCtrl = TextEditingController();
  bool _testing = false;
  bool _saving = false;
  String _testResult = '';
  bool _testSuccess = false;

  @override
  void dispose() {
    _urlCtrl.dispose();
    _keyCtrl.dispose();
    super.dispose();
  }

  Future<void> _testConnection() async {
    final url = _urlCtrl.text.trim();
    final key = _keyCtrl.text.trim();
    if (url.isEmpty || key.isEmpty) {
      setState(() { _testResult = 'Please enter Worker URL and API Key.'; _testSuccess = false; });
      return;
    }
    setState(() { _testing = true; _testResult = ''; });
    try {
      final res = await http.post(
        Uri.parse('${url.trimRight()}/api/sms/forward'),
        headers: {'Content-Type': 'application/json', 'X-API-Key': key},
        body: jsonEncode({
          'sender': '01700000000',
          'message': 'You have received Tk 10.00 from 01700000000. TrxID TESTTEST01. Balance Tk 100.00.',
          'receivedAt': DateTime.now().toUtc().toIso8601String(),
        }),
      ).timeout(const Duration(seconds: 15));

      if (res.statusCode == 200 || res.statusCode == 201) {
        setState(() { _testResult = '✅ Connection successful! Worker is running correctly.'; _testSuccess = true; });
      } else if (res.statusCode == 401) {
        setState(() { _testResult = '❌ Invalid API Key.'; _testSuccess = false; });
      } else {
        setState(() { _testResult = '⚠️ Server response: ${res.statusCode}'; _testSuccess = false; });
      }
    } on TimeoutException {
      setState(() { _testResult = '❌ Timeout. Please check the URL.'; _testSuccess = false; });
    } catch (e) {
      setState(() { _testResult = '❌ Error: ${e.toString().substring(0, e.toString().length.clamp(0, 80))}'; _testSuccess = false; });
    }
    setState(() => _testing = false);
  }

  Future<void> _saveAndContinue() async {
    final url = _urlCtrl.text.trim();
    final key = _keyCtrl.text.trim();
    if (url.isEmpty) { _showSnack('Please enter Worker URL'); return; }
    if (key.isEmpty) { _showSnack('Please enter API Key'); return; }
    if (!url.startsWith('http')) { _showSnack('URL must start with https://'); return; }

    setState(() => _saving = true);
    await _requestPermissions();

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(kWorkerUrl, url);
    await prefs.setString(kApiKey, key);
    await prefs.setBool(kEnabled, true);
    await prefs.setBool(kSetupDone, true);

    try { await _smsChannel.invokeMethod('startService'); } catch (_) {}

    if (mounted) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const HomeScreen()),
      );
    }
  }

  Future<void> _requestPermissions() async {
    try { await _smsChannel.invokeMethod('requestSmsPermission'); } catch (_) {}
    await Permission.notification.request();
  }

  void _showSnack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: kDanger),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 24),
              Row(
                children: [
                  Container(
                    width: 48, height: 48,
                    decoration: BoxDecoration(color: kPrimary, borderRadius: BorderRadius.circular(12)),
                    child: const Icon(Icons.bolt, color: Colors.white, size: 28),
                  ),
                  const SizedBox(width: 14),
                  const Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('PayGate SMS', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: Colors.white)),
                      Text('bKash SMS Forwarder', style: TextStyle(fontSize: 13, color: kMuted)),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 32),
              _infoCard(
                icon: Icons.info_outline, color: kPrimary,
                title: 'Initial Setup',
                body: 'This app will automatically forward your bKash SMS messages to your Cloudflare Worker.',
              ),
              const SizedBox(height: 20),
              _label('Worker URL'),
              _textField(controller: _urlCtrl, hint: 'https://your-worker.workers.dev', icon: Icons.link, keyboard: TextInputType.url),
              const SizedBox(height: 16),
              _label('API Key'),
              _textField(controller: _keyCtrl, hint: 'Your Worker API Key', icon: Icons.key, obscure: true),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _testing ? null : _testConnection,
                  icon: _testing
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: kPrimary))
                      : const Icon(Icons.wifi_tethering, size: 18),
                  label: Text(_testing ? 'Testing...' : 'Test Connection'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: kPrimary, side: const BorderSide(color: kPrimary),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                ),
              ),
              if (_testResult.isNotEmpty) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: _testSuccess ? const Color(0xFF0F2D1A) : const Color(0xFF2D1212),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _testSuccess ? kSuccess : kDanger),
                  ),
                  child: Text(_testResult, style: TextStyle(fontSize: 13, color: _testSuccess ? kSuccess : const Color(0xFFFCA5A5))),
                ),
              ],
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _saving ? null : _saveAndContinue,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: kPrimary,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                  child: _saving
                      ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                      : const Text('Save & Get Started →', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Colors.white)),
                ),
              ),
              const SizedBox(height: 32),
              _sectionTitle('How It Works'),
              const SizedBox(height: 12),
              _stepCard('1', 'Instantly forwards SMS as soon as it arrives from bKash'),
              _stepCard('2', 'Checks SMS inbox every 15 seconds in the background'),
              _stepCard('3', 'Status is always visible in the notification bar'),
              _stepCard('4', 'Automatically restarts after phone reboot'),
            ],
          ),
        ),
      ),
    );
  }

  Widget _label(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(text, style: const TextStyle(fontSize: 13, color: kMuted, fontWeight: FontWeight.w500)),
  );

  Widget _textField({
    required TextEditingController controller,
    required String hint,
    required IconData icon,
    TextInputType? keyboard,
    bool obscure = false,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboard,
      obscureText: obscure,
      style: const TextStyle(color: Colors.white, fontSize: 14),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: kMuted, fontSize: 13),
        prefixIcon: Icon(icon, color: kMuted, size: 20),
        filled: true, fillColor: const Color(0xFF111111),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: kBorder)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: kBorder)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: kPrimary)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      ),
    );
  }

  Widget _infoCard({required IconData icon, required Color color, required String title, required String body}) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: kCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: kBorder)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 22),
          const SizedBox(width: 12),
          Expanded(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14, color: Colors.white)),
              const SizedBox(height: 4),
              Text(body, style: const TextStyle(fontSize: 13, color: kMuted, height: 1.6)),
            ],
          )),
        ],
      ),
    );
  }

  Widget _sectionTitle(String text) => Text(text, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Colors.white));

  Widget _stepCard(String num, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Container(
            width: 28, height: 28,
            decoration: BoxDecoration(color: kPrimary, borderRadius: BorderRadius.circular(14)),
            child: Center(child: Text(num, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Colors.white))),
          ),
          const SizedBox(width: 12),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 13, color: kMuted, height: 1.5))),
        ],
      ),
    );
  }
}

// ─── Home Screen ──────────────────────────────────────────────────────────────
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  String _workerUrl = '';
  String _apiKey = '';
  bool _enabled = true;
  int _forwardCount = 0;
  String _lastLog = '';
  bool _hasPerms = false;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadPrefs();
    _checkPermissions();
    _refreshTimer = Timer.periodic(const Duration(seconds: 3), (_) => _loadPrefs());
    _startService();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refreshTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.detached) {
      _startService();
    }
  }

  Future<void> _startService() async {
    try { await _smsChannel.invokeMethod('startService'); } catch (_) {}
  }

  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _workerUrl = prefs.getString(kWorkerUrl) ?? '';
      _apiKey = prefs.getString(kApiKey) ?? '';
      _enabled = prefs.getBool(kEnabled) ?? true;
      _forwardCount = prefs.getInt(kForwardCount) ?? 0;
      _lastLog = prefs.getString(kLastLog) ?? 'No activity yet';
    });
  }

  Future<void> _checkPermissions() async {
    try {
      final granted = await _smsChannel.invokeMethod<bool>('hasSmsPermission') ?? false;
      if (mounted) setState(() => _hasPerms = granted);
    } catch (_) {
      final sms = await Permission.sms.status;
      if (mounted) setState(() => _hasPerms = sms.isGranted);
    }
  }

  Future<void> _toggleEnabled() async {
    final prefs = await SharedPreferences.getInstance();
    final newVal = !_enabled;
    await prefs.setBool(kEnabled, newVal);
    setState(() => _enabled = newVal);
    if (newVal) {
      _startService();
    } else {
      try { await _smsChannel.invokeMethod('stopService'); } catch (_) {}
    }
  }

  Future<void> _requestPerms() async {
    try { await _smsChannel.invokeMethod('requestSmsPermission'); } catch (_) {
      await Permission.sms.request();
    }
    await Permission.notification.request();
    await Future.delayed(const Duration(seconds: 1));
    await _checkPermissions();
  }

  void _openSettings() {
    Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen()))
        .then((_) => _loadPrefs());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            // Top bar
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
              decoration: const BoxDecoration(
                color: Color(0xFF111111),
                border: Border(bottom: BorderSide(color: kBorder)),
              ),
              child: Row(
                children: [
                  Container(
                    width: 36, height: 36,
                    decoration: BoxDecoration(color: kPrimary, borderRadius: BorderRadius.circular(8)),
                    child: const Icon(Icons.bolt, color: Colors.white, size: 20),
                  ),
                  const SizedBox(width: 10),
                  const Text('PayGate SMS', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: Colors.white)),
                  const Spacer(),
                  IconButton(onPressed: _openSettings, icon: const Icon(Icons.settings, color: kMuted)),
                ],
              ),
            ),

            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Permission warning
                    if (!_hasPerms) ...[
                      _alertCard(
                        color: kDanger, bgColor: const Color(0xFF2D1212),
                        icon: Icons.warning_amber,
                        title: 'SMS Permission Required!',
                        body: 'Permission is required to forward SMS messages.',
                        action: TextButton(
                          onPressed: _requestPerms,
                          child: const Text('Grant Permission', style: TextStyle(color: kDanger, fontWeight: FontWeight.w600)),
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],

                    // Status card
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          colors: _enabled && _hasPerms
                              ? [const Color(0xFF0F2D1A), const Color(0xFF1A4A2A)]
                              : [const Color(0xFF1A1A1A), const Color(0xFF222222)],
                          begin: Alignment.topLeft, end: Alignment.bottomRight,
                        ),
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: _enabled && _hasPerms ? kSuccess.withValues(alpha: 0.4) : kBorder),
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: 52, height: 52,
                            decoration: BoxDecoration(
                              color: (_enabled && _hasPerms ? kSuccess : kMuted).withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(26),
                            ),
                            child: Icon(
                              _enabled && _hasPerms ? Icons.sms : Icons.sms_failed,
                              color: _enabled && _hasPerms ? kSuccess : kMuted, size: 26,
                            ),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _enabled && _hasPerms ? 'SMS Forwarding Active' : 'SMS Forwarding Inactive',
                                  style: TextStyle(
                                    fontSize: 15, fontWeight: FontWeight.w700,
                                    color: _enabled && _hasPerms ? kSuccess : kMuted,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _enabled && _hasPerms
                                      ? 'Notification running • Checks every 15 seconds'
                                      : _hasPerms ? 'Toggle to enable' : 'Grant SMS permission',
                                  style: const TextStyle(fontSize: 12, color: kMuted),
                                ),
                              ],
                            ),
                          ),
                          Switch(
                            value: _enabled,
                            onChanged: (_) => _toggleEnabled(),
                            activeThumbColor: kSuccess,
                            activeTrackColor: kSuccess.withValues(alpha: 0.3),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),

                    // Stats
                    Row(
                      children: [
                        Expanded(child: _statCard('Forwarded', '$_forwardCount', Icons.send, kPrimary)),
                        const SizedBox(width: 12),
                        Expanded(child: _statCard('Permission', _hasPerms ? 'Granted' : 'Denied',
                            _hasPerms ? Icons.check_circle : Icons.cancel, _hasPerms ? kSuccess : kDanger)),
                        const SizedBox(width: 12),
                        Expanded(child: _statCard('Service', _enabled ? 'Running' : 'Stopped',
                            _enabled ? Icons.circle : Icons.pause_circle, _enabled ? kSuccess : kWarning)),
                      ],
                    ),
                    const SizedBox(height: 16),

                    // Service info card
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: const Color(0xFF0F1E2D),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFF3B82F6).withValues(alpha: 0.3)),
                      ),
                      child: const Row(
                        children: [
                          Icon(Icons.notifications_active, color: Color(0xFF60A5FA), size: 20),
                          SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              'Background service is running. Always visible in the notification bar. Checks SMS inbox every 15 seconds.',
                              style: TextStyle(fontSize: 12, color: Color(0xFF93C5FD), height: 1.5),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),

                    // Last log
                    _sectionTitle('Last Activity'),
                    const SizedBox(height: 8),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: const Color(0xFF111111),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: kBorder),
                      ),
                      child: Text(_lastLog,
                        style: const TextStyle(fontSize: 13, color: kMuted, fontFamily: 'monospace', height: 1.5)),
                    ),
                    const SizedBox(height: 16),

                    // Config
                    _sectionTitle('Current Config'),
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(color: kCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: kBorder)),
                      child: Column(
                        children: [
                          _configRow('Worker URL', _workerUrl.isEmpty ? 'Not set' : _workerUrl),
                          const Divider(color: kBorder, height: 20),
                          _configRow('API Key', _apiKey.isEmpty ? 'Not set' : '${_apiKey.substring(0, _apiKey.length.clamp(0, 6))}••••••'),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),

                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        onPressed: _openSettings,
                        icon: const Icon(Icons.tune, size: 18),
                        label: const Text('Open Settings'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: kPrimary, side: const BorderSide(color: kPrimary),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionTitle(String t) => Text(t, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Colors.white));

  Widget _statCard(String label, String value, IconData icon, Color color) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: kCard, borderRadius: BorderRadius.circular(10), border: Border.all(color: kBorder)),
      child: Column(children: [
        Icon(icon, color: color, size: 22),
        const SizedBox(height: 6),
        Text(value, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: color)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(fontSize: 11, color: kMuted)),
      ]),
    );
  }

  Widget _configRow(String label, String value) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(width: 90, child: Text(label, style: const TextStyle(fontSize: 13, color: kMuted))),
        Expanded(child: Text(value, style: const TextStyle(fontSize: 13, color: Colors.white), overflow: TextOverflow.ellipsis, maxLines: 2)),
      ],
    );
  }

  Widget _alertCard({required Color color, required Color bgColor, required IconData icon, required String title, required String body, Widget? action}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: bgColor, borderRadius: BorderRadius.circular(10), border: Border.all(color: color.withValues(alpha: 0.5))),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: TextStyle(fontWeight: FontWeight.w600, color: color, fontSize: 13)),
              Text(body, style: const TextStyle(fontSize: 12, color: kMuted)),
              ?action,
            ],
          )),
        ],
      ),
    );
  }
}

// ─── Settings Screen ──────────────────────────────────────────────────────────
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _urlCtrl = TextEditingController();
  final _keyCtrl = TextEditingController();
  bool _saved = false;
  bool _testing = false;
  String _testResult = '';
  bool _testSuccess = false;

  @override
  void initState() { super.initState(); _loadPrefs(); }

  @override
  void dispose() { _urlCtrl.dispose(); _keyCtrl.dispose(); super.dispose(); }

  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    _urlCtrl.text = prefs.getString(kWorkerUrl) ?? '';
    _keyCtrl.text = prefs.getString(kApiKey) ?? '';
  }

  Future<void> _save() async {
    final url = _urlCtrl.text.trim();
    final key = _keyCtrl.text.trim();
    if (url.isEmpty || key.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Please enter URL and API Key'), backgroundColor: kDanger));
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(kWorkerUrl, url);
    await prefs.setString(kApiKey, key);
    setState(() => _saved = true);
    Future.delayed(const Duration(seconds: 2), () { if (mounted) setState(() => _saved = false); });
  }

  Future<void> _testConnection() async {
    final url = _urlCtrl.text.trim();
    final key = _keyCtrl.text.trim();
    if (url.isEmpty || key.isEmpty) { setState(() { _testResult = 'Please enter URL and API Key.'; _testSuccess = false; }); return; }
    setState(() { _testing = true; _testResult = ''; });
    try {
      final res = await http.post(
        Uri.parse('${url.trimRight()}/api/sms/forward'),
        headers: {'Content-Type': 'application/json', 'X-API-Key': key},
        body: jsonEncode({'sender': '01700000000', 'message': 'You have received Tk 10.00 from 01700000000. TrxID TESTCONN01. Balance Tk 100.00.', 'receivedAt': DateTime.now().toUtc().toIso8601String()}),
      ).timeout(const Duration(seconds: 15));
      setState(() {
        _testSuccess = res.statusCode >= 200 && res.statusCode < 300;
        _testResult = _testSuccess ? '✅ Connection successful! (HTTP ${res.statusCode})' : '❌ HTTP ${res.statusCode}';
      });
    } catch (e) {
      setState(() { _testResult = '❌ Error: ${e.toString().substring(0, e.toString().length.clamp(0, 80))}'; _testSuccess = false; });
    }
    setState(() => _testing = false);
  }

  Future<void> _resetApp() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: kCard,
        title: const Text('Reset App?', style: TextStyle(color: Colors.white)),
        content: const Text('All settings will be cleared and you will be taken to the setup screen.', style: TextStyle(color: kMuted)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Yes, Reset', style: TextStyle(color: kDanger))),
        ],
      ),
    );
    if (confirm == true) {
      try { await _smsChannel.invokeMethod('stopService'); } catch (_) {}
      final prefs = await SharedPreferences.getInstance();
      await prefs.clear();
      if (mounted) {
        Navigator.of(context).pushAndRemoveUntil(
          MaterialPageRoute(builder: (_) => const SetupScreen()), (_) => false,
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(0xFF111111),
        title: const Text('Settings', style: TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600)),
        leading: IconButton(icon: const Icon(Icons.arrow_back, color: Colors.white), onPressed: () => Navigator.pop(context)),
        bottom: const PreferredSize(preferredSize: Size.fromHeight(1), child: Divider(height: 1, color: kBorder)),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_saved)
              Container(
                width: double.infinity, padding: const EdgeInsets.all(12), margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(color: const Color(0xFF0F2D1A), borderRadius: BorderRadius.circular(8), border: Border.all(color: kSuccess.withValues(alpha: 0.5))),
                child: const Text('✅ Settings saved successfully!', style: TextStyle(color: kSuccess, fontSize: 13)),
              ),
            const Text('Worker Configuration', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Colors.white)),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(color: kCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: kBorder)),
              child: Column(children: [
                _settingsField('Worker URL', _urlCtrl, 'https://your-worker.workers.dev', Icons.link),
                const SizedBox(height: 14),
                _settingsField('API Key', _keyCtrl, 'Your API Key', Icons.key, obscure: true),
              ]),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _testing ? null : _testConnection,
                    icon: _testing ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: kPrimary)) : const Icon(Icons.wifi_tethering, size: 16),
                    label: const Text('Test'),
                    style: OutlinedButton.styleFrom(foregroundColor: kPrimary, side: const BorderSide(color: kPrimary), padding: const EdgeInsets.symmetric(vertical: 12), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: _save,
                    icon: const Icon(Icons.save, size: 16, color: Colors.white),
                    label: const Text('Save', style: TextStyle(color: Colors.white)),
                    style: ElevatedButton.styleFrom(backgroundColor: kPrimary, padding: const EdgeInsets.symmetric(vertical: 12), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))),
                  ),
                ),
              ],
            ),
            if (_testResult.isNotEmpty) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: _testSuccess ? const Color(0xFF0F2D1A) : const Color(0xFF2D1212), borderRadius: BorderRadius.circular(8), border: Border.all(color: (_testSuccess ? kSuccess : kDanger).withValues(alpha: 0.5))),
                child: Text(_testResult, style: TextStyle(fontSize: 12, color: _testSuccess ? kSuccess : const Color(0xFFFCA5A5))),
              ),
            ],
            const SizedBox(height: 24),
            const Divider(color: kBorder),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: _resetApp,
                icon: const Icon(Icons.restore, size: 16),
                label: const Text('Reset App'),
                style: OutlinedButton.styleFrom(foregroundColor: kDanger, side: const BorderSide(color: kDanger), padding: const EdgeInsets.symmetric(vertical: 12), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))),
              ),
            ),
            const SizedBox(height: 20),
            const Center(child: Text('PayGate SMS Forwarder v1.0.0', style: TextStyle(fontSize: 11, color: kMuted))),
          ],
        ),
      ),
    );
  }

  Widget _settingsField(String label, TextEditingController ctrl, String hint, IconData icon, {bool obscure = false}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 12, color: kMuted, fontWeight: FontWeight.w500)),
        const SizedBox(height: 6),
        TextField(
          controller: ctrl, obscureText: obscure,
          style: const TextStyle(color: Colors.white, fontSize: 13),
          decoration: InputDecoration(
            hintText: hint, hintStyle: const TextStyle(color: kMuted, fontSize: 12),
            prefixIcon: Icon(icon, color: kMuted, size: 18), filled: true, fillColor: const Color(0xFF111111),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: kBorder)),
            enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: kBorder)),
            focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: kPrimary)),
            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          ),
        ),
      ],
    );
  }
}
