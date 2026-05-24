import 'package:flutter_test/flutter_test.dart';

import 'package:paygate/main.dart';

void main() {
  testWidgets('SetupScreen renders correctly', (WidgetTester tester) async {
    await tester.pumpWidget(const PayGateApp(setupDone: false));
    expect(find.text('PayGate SMS'), findsWidgets);
  });
}
