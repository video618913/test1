import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';

const MethodChannel _smsChannel = MethodChannel('com.example.paygate/sms');

// ─── Constants ────────────────────────────────────────────────────────────────
const String kWorkerUrl    = 'worker_url';
const String kApiKey       = 'api_key';
const String kEnabled      = 'sms_forward_enabled';
const String kForwardCount = 'forward_count';
const String kLastLog      = 'last_log';
const String kSetupDone    = 'setup_done';

const Color kBg      = Color(0xFF0A0A0A);
const Color kSurface = Color(0xFF141414);
const Color kBorder  = Color(0xFF242424);
const Color kMuted   = Color(0xFF555555);
const Color kText    = Color(0xFFE8E8E8);
const Color kPrimary = Color(0xFFE2136E);
const Color kGreen   = Color(0xFF22C55E);
const Color kRed     = Color(0xFFEF4444);

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
  ));
  final prefs = await SharedPreferences.getInstance();
  runApp(PayGateApp(setupDone: prefs.getBool(kSetupDone) ?? false));
}

class PayGateApp extends StatelessWidget {
  final bool setupDone;
  const PayGateApp({super.key, required this.setupDone});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PayGate',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: kBg,
        colorScheme: const ColorScheme.dark(primary: kPrimary, surface: kSurface),
      ),
      home: setupDone ? const HomeScreen() : const SetupScreen(),
    );
  }
}

// ─── Shared Widgets ───────────────────────────────────────────────────────────
class _Field extends StatelessWidget {
  final TextEditingController ctrl;
  final String label;
  final String hint;
  final bool obscure;
  final TextInputType? keyboard;

  const _Field({
    required this.ctrl,
    required this.label,
    required this.hint,
    this.obscure = false,
    this.keyboard,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 11, color: kMuted, letterSpacing: 0.8)),
        const SizedBox(height: 6),
        TextField(
          controller: ctrl,
          obscureText: obscure,
          keyboardType: keyboard,
          style: const TextStyle(color: kText, fontSize: 14),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: const TextStyle(color: kMuted, fontSize: 13),
            filled: true,
            fillColor: kSurface,
            contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: const BorderSide(color: kBorder),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: const BorderSide(color: kBorder),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: const BorderSide(color: kPrimary),
            ),
          ),
        ),
      ],
    );
  }
}

Widget _btn(String label, VoidCallback? onTap, {bool outline = false, bool danger = false}) {
  final color = danger ? kRed : kPrimary;
  return SizedBox(
    width: double.infinity,
    height: 46,
    child: outline
        ? OutlinedButton(
            onPressed: onTap,
            style: OutlinedButton.styleFrom(
              foregroundColor: color,
              side: BorderSide(color: color),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
            child: Text(label, style: const TextStyle(fontSize: 14)),
          )
        : ElevatedButton(
            onPressed: onTap,
            style: ElevatedButton.styleFrom(
              backgroundColor: color,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
            child: Text(label, style: const TextStyle(fontSize: 14, color: Colors.white)),
          ),
  );
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
  bool _saving  = false;
  String _testMsg = '';
  bool _testOk  = false;

  @override
  void dispose() { _urlCtrl.dispose(); _keyCtrl.dispose(); super.dispose(); }

  Future<void> _test() async {
    final url = _urlCtrl.text.trim();
    final key = _keyCtrl.text.trim();
    if (url.isEmpty || key.isEmpty) {
      setState(() { _testMsg = 'Enter URL and API key first.'; _testOk = false; });
      return;
    }
    setState(() { _testing = true; _testMsg = ''; });
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

      final ok = res.statusCode >= 200 && res.statusCode < 300;
      setState(() {
        _testOk  = ok;
        _testMsg = ok ? 'Connection successful.' : 'HTTP ${res.statusCode}';
      });
    } on TimeoutException {
      setState(() { _testMsg = 'Request timed out.'; _testOk = false; });
    } catch (e) {
      setState(() { _testMsg = 'Error: $e'; _testOk = false; });
    }
    setState(() => _testing = false);
  }

  Future<void> _save() async {
    final url = _urlCtrl.text.trim();
    final key = _keyCtrl.text.trim();
    if (url.isEmpty) { _snack('Enter Worker URL'); return; }
    if (key.isEmpty) { _snack('Enter API Key'); return; }
    if (!url.startsWith('http')) { _snack('URL must start with https://'); return; }
    setState(() => _saving = true);

    try { await _smsChannel.invokeMethod('requestSmsPermission'); } catch (_) {}
    await Permission.notification.request();

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(kWorkerUrl, url);
    await prefs.setString(kApiKey, key);
    await prefs.setBool(kEnabled, true);
    await prefs.setBool(kSetupDone, true);

    try { await _smsChannel.invokeMethod('startService'); } catch (_) {}

    if (mounted) {
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomeScreen()));
    }
  }

  void _snack(String msg) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(msg), backgroundColor: kRed));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Logo
              Container(
                width: 40, height: 40,
                decoration: BoxDecoration(color: kPrimary, borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.bolt, color: Colors.white, size: 22),
              ),
              const SizedBox(height: 20),
              const Text('Setup', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, color: kText)),
              const SizedBox(height: 6),
              const Text('Connect your Cloudflare Worker to start forwarding bKash SMS.',
                  style: TextStyle(fontSize: 14, color: kMuted, height: 1.5)),
              const SizedBox(height: 36),

              _Field(ctrl: _urlCtrl, label: 'WORKER URL', hint: 'https://your-worker.workers.dev',
                  keyboard: TextInputType.url),
              const SizedBox(height: 16),
              _Field(ctrl: _keyCtrl, label: 'API KEY', hint: 'Paste your API key', obscure: true),
              const SizedBox(height: 24),

              // Test result
              if (_testMsg.isNotEmpty) ...[
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: _testOk ? const Color(0xFF0D1F12) : const Color(0xFF1F0D0D),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _testOk ? const Color(0xFF1E4D2A) : const Color(0xFF4D1E1E)),
                  ),
                  child: Text(_testMsg,
                      style: TextStyle(fontSize: 13, color: _testOk ? kGreen : kRed)),
                ),
              ],

              _btn(_testing ? 'Testing…' : 'Test Connection', _testing ? null : _test, outline: true),
              const SizedBox(height: 10),
              _btn(_saving ? 'Saving…' : 'Save & Continue', _saving ? null : _save),

              const SizedBox(height: 40),
              const Divider(color: kBorder),
              const SizedBox(height: 20),

              const Text('How it works', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: kText)),
              const SizedBox(height: 12),
              ...[
                'Forwards bKash SMS instantly when received',
                'Polls SMS inbox every 15 seconds as backup',
                'Runs in background, visible in notification bar',
                'Restarts automatically after phone reboot',
              ].map((s) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('—  ', style: TextStyle(color: kMuted, fontSize: 13)),
                    Expanded(child: Text(s, style: const TextStyle(color: kMuted, fontSize: 13, height: 1.4))),
                  ],
                ),
              )),
            ],
          ),
        ),
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
  String _workerUrl    = '';
  String _apiKey       = '';
  bool   _enabled      = true;
  int    _forwardCount = 0;
  String _lastLog      = '';
  bool   _hasPerms     = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
    _checkPerms();
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _load());
    _startService();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.paused || s == AppLifecycleState.detached) _startService();
  }

  Future<void> _startService() async {
    try { await _smsChannel.invokeMethod('startService'); } catch (_) {}
  }

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _workerUrl    = p.getString(kWorkerUrl) ?? '';
      _apiKey       = p.getString(kApiKey) ?? '';
      _enabled      = p.getBool(kEnabled) ?? true;
      _forwardCount = p.getInt(kForwardCount) ?? 0;
      _lastLog      = p.getString(kLastLog) ?? '—';
    });
  }

  Future<void> _checkPerms() async {
    try {
      final ok = await _smsChannel.invokeMethod<bool>('hasSmsPermission') ?? false;
      if (mounted) setState(() => _hasPerms = ok);
    } catch (_) {
      final s = await Permission.sms.status;
      if (mounted) setState(() => _hasPerms = s.isGranted);
    }
  }

  Future<void> _toggleEnabled() async {
    final p = await SharedPreferences.getInstance();
    final next = !_enabled;
    await p.setBool(kEnabled, next);
    setState(() => _enabled = next);
    if (next) {
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
    await _checkPerms();
  }

  @override
  Widget build(BuildContext context) {
    final active = _enabled && _hasPerms;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            // Top bar
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
              child: Row(
                children: [
                  Container(
                    width: 32, height: 32,
                    decoration: BoxDecoration(color: kPrimary, borderRadius: BorderRadius.circular(8)),
                    child: const Icon(Icons.bolt, color: Colors.white, size: 18),
                  ),
                  const SizedBox(width: 10),
                  const Text('PayGate', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: kText)),
                  const Spacer(),
                  GestureDetector(
                    onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen()))
                        .then((_) => _load()),
                    child: const Icon(Icons.settings_outlined, color: kMuted, size: 22),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: kBorder),

            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [

                    // Permission warning
                    if (!_hasPerms) ...[
                      _notice(
                        'SMS permission required.',
                        action: GestureDetector(
                          onTap: _requestPerms,
                          child: const Text('Grant →', style: TextStyle(color: kRed, fontSize: 13, fontWeight: FontWeight.w600)),
                        ),
                        color: kRed,
                      ),
                      const SizedBox(height: 16),
                    ],

                    // Status row
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                      decoration: BoxDecoration(
                        color: kSurface,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: kBorder),
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: 8, height: 8,
                            decoration: BoxDecoration(
                              color: active ? kGreen : kMuted,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  active ? 'Forwarding active' : 'Forwarding inactive',
                                  style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w600,
                                    color: active ? kGreen : kMuted,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  active
                                    ? 'Running · checks every 15s'
                                    : _hasPerms ? 'Toggle to enable' : 'SMS permission needed',
                                  style: const TextStyle(fontSize: 12, color: kMuted),
                                ),
                              ],
                            ),
                          ),
                          Switch(
                            value: _enabled,
                            onChanged: (_) => _toggleEnabled(),
                            activeThumbColor: kGreen,
                            activeTrackColor: const Color(0xFF0D2A14),
                            inactiveThumbColor: kMuted,
                            inactiveTrackColor: kSurface,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),

                    // Stats row
                    Row(
                      children: [
                        _stat('Forwarded', '$_forwardCount'),
                        const SizedBox(width: 10),
                        _stat('Permission', _hasPerms ? 'Granted' : 'Denied'),
                        const SizedBox(width: 10),
                        _stat('Service', _enabled ? 'On' : 'Off'),
                      ],
                    ),
                    const SizedBox(height: 20),

                    // Last activity
                    const Text('Last activity', style: TextStyle(fontSize: 11, color: kMuted, letterSpacing: 0.8)),
                    const SizedBox(height: 8),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: kSurface,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: kBorder),
                      ),
                      child: Text(_lastLog,
                          style: const TextStyle(fontSize: 12, color: kMuted, fontFamily: 'monospace', height: 1.5)),
                    ),
                    const SizedBox(height: 20),

                    // Config
                    const Text('Configuration', style: TextStyle(fontSize: 11, color: kMuted, letterSpacing: 0.8)),
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: kSurface,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: kBorder),
                      ),
                      child: Column(
                        children: [
                          _cfgRow('URL', _workerUrl.isEmpty ? 'Not set' : _workerUrl),
                          const SizedBox(height: 10),
                          const Divider(color: kBorder, height: 1),
                          const SizedBox(height: 10),
                          _cfgRow('Key',
                            _apiKey.isEmpty
                              ? 'Not set'
                              : '${_apiKey.substring(0, _apiKey.length.clamp(0, 6))}••••••'),
                        ],
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

  Widget _stat(String label, String val) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(color: kSurface, borderRadius: BorderRadius.circular(8), border: Border.all(color: kBorder)),
        child: Column(
          children: [
            Text(val, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: kText)),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(fontSize: 11, color: kMuted)),
          ],
        ),
      ),
    );
  }

  Widget _cfgRow(String label, String val) {
    return Row(
      children: [
        SizedBox(width: 36, child: Text(label, style: const TextStyle(fontSize: 12, color: kMuted))),
        const SizedBox(width: 10),
        Expanded(
          child: Text(val,
              style: const TextStyle(fontSize: 12, color: kText),
              overflow: TextOverflow.ellipsis, maxLines: 1),
        ),
      ],
    );
  }

  Widget _notice(String msg, {Widget? action, required Color color}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: kSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          Icon(Icons.info_outline, color: color, size: 16),
          const SizedBox(width: 10),
          Expanded(child: Text(msg, style: TextStyle(fontSize: 13, color: color))),
          ?action,
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
  bool _saved    = false;
  bool _testing  = false;
  String _testMsg = '';
  bool _testOk   = false;

  @override
  void initState() { super.initState(); _load(); }

  @override
  void dispose() { _urlCtrl.dispose(); _keyCtrl.dispose(); super.dispose(); }

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    _urlCtrl.text = p.getString(kWorkerUrl) ?? '';
    _keyCtrl.text = p.getString(kApiKey) ?? '';
  }

  Future<void> _save() async {
    final url = _urlCtrl.text.trim();
    final key = _keyCtrl.text.trim();
    if (url.isEmpty || key.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Enter URL and API Key'), backgroundColor: kRed));
      return;
    }
    final p = await SharedPreferences.getInstance();
    await p.setString(kWorkerUrl, url);
    await p.setString(kApiKey, key);
    setState(() => _saved = true);
    Future.delayed(const Duration(seconds: 2), () { if (mounted) setState(() => _saved = false); });
  }

  Future<void> _test() async {
    final url = _urlCtrl.text.trim();
    final key = _keyCtrl.text.trim();
    if (url.isEmpty || key.isEmpty) {
      setState(() { _testMsg = 'Enter URL and API key first.'; _testOk = false; });
      return;
    }
    setState(() { _testing = true; _testMsg = ''; });
    try {
      final res = await http.post(
        Uri.parse('${url.trimRight()}/api/sms/forward'),
        headers: {'Content-Type': 'application/json', 'X-API-Key': key},
        body: jsonEncode({
          'sender': '01700000000',
          'message': 'You have received Tk 10.00 from 01700000000. TrxID TESTCONN01. Balance Tk 100.00.',
          'receivedAt': DateTime.now().toUtc().toIso8601String(),
        }),
      ).timeout(const Duration(seconds: 15));
      final ok = res.statusCode >= 200 && res.statusCode < 300;
      setState(() { _testOk = ok; _testMsg = ok ? 'Connection successful.' : 'HTTP ${res.statusCode}'; });
    } catch (e) {
      setState(() { _testMsg = 'Error: $e'; _testOk = false; });
    }
    setState(() => _testing = false);
  }

  Future<void> _reset() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: kSurface,
        title: const Text('Reset app?', style: TextStyle(color: kText, fontSize: 16)),
        content: const Text('All settings will be cleared.', style: TextStyle(color: kMuted, fontSize: 14)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel', style: TextStyle(color: kMuted))),
          TextButton(onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Reset', style: TextStyle(color: kRed))),
        ],
      ),
    );
    if (ok == true) {
      try { await _smsChannel.invokeMethod('stopService'); } catch (_) {}
      final p = await SharedPreferences.getInstance();
      await p.clear();
      if (mounted) {
        Navigator.of(context).pushAndRemoveUntil(
            MaterialPageRoute(builder: (_) => const SetupScreen()), (_) => false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: kBg,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: kText, size: 20),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text('Settings', style: TextStyle(color: kText, fontSize: 15, fontWeight: FontWeight.w600)),
        bottom: const PreferredSize(preferredSize: Size.fromHeight(1), child: Divider(height: 1, color: kBorder)),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [

            if (_saved) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: const Color(0xFF0D1F12),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF1E4D2A)),
                ),
                child: const Text('Settings saved.', style: TextStyle(color: kGreen, fontSize: 13)),
              ),
            ],

            _Field(ctrl: _urlCtrl, label: 'WORKER URL', hint: 'https://your-worker.workers.dev',
                keyboard: TextInputType.url),
            const SizedBox(height: 14),
            _Field(ctrl: _keyCtrl, label: 'API KEY', hint: 'Paste your API key', obscure: true),
            const SizedBox(height: 20),

            if (_testMsg.isNotEmpty) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                margin: const EdgeInsets.only(bottom: 14),
                decoration: BoxDecoration(
                  color: _testOk ? const Color(0xFF0D1F12) : const Color(0xFF1F0D0D),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: _testOk ? const Color(0xFF1E4D2A) : const Color(0xFF4D1E1E)),
                ),
                child: Text(_testMsg, style: TextStyle(fontSize: 13, color: _testOk ? kGreen : kRed)),
              ),
            ],

            Row(
              children: [
                Expanded(child: SizedBox(
                  height: 46,
                  child: OutlinedButton(
                    onPressed: _testing ? null : _test,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: kPrimary,
                      side: const BorderSide(color: kBorder),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    child: Text(_testing ? 'Testing…' : 'Test', style: const TextStyle(fontSize: 14)),
                  ),
                )),
                const SizedBox(width: 10),
                Expanded(child: SizedBox(
                  height: 46,
                  child: ElevatedButton(
                    onPressed: _save,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: kPrimary,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    child: const Text('Save', style: TextStyle(fontSize: 14, color: Colors.white)),
                  ),
                )),
              ],
            ),

            const SizedBox(height: 32),
            const Divider(color: kBorder),
            const SizedBox(height: 20),

            _btn('Reset App', _reset, outline: true, danger: true),

            const SizedBox(height: 24),
            const Center(
              child: Text('PayGate SMS Forwarder v1.0.0',
                  style: TextStyle(fontSize: 11, color: kMuted)),
            ),
          ],
        ),
      ),
    );
  }
}
