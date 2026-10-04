import 'package:flutter/material.dart';
import 'dart:developer' as developer;

Future<void> writePreviewLogs() async {
  print('点击 print 中文\n第二行');
  debugPrint('点击 debugPrint 中文');
  developer.log('点击 developer.log 中文', name: 'preview-fixture', level: 900,
    error: StateError('fixture error'), stackTrace: StackTrace.current);
  print('重复消息');
  print('重复消息');
  await Future<void>.delayed(const Duration(milliseconds: 50));
  print('异步 print 中文');
  debugPrint('异步 debugPrint 中文');
  developer.log('异步 developer.log 中文', name: 'preview-fixture', level: 800);
}

void main() {
  WidgetsFlutterBinding.ensureInitialized().ensureSemantics();
  runApp(const PreviewApp());
}

class PreviewApp extends StatelessWidget {
  const PreviewApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    theme: ThemeData(colorSchemeSeed: const Color(0xff087f8c)),
    home: Scaffold(
      appBar: AppBar(title: const Text('Flutter Web Preview')),
      body: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('Preview version 1'),
        ElevatedButton(onPressed: writePreviewLogs, child: const Text('Emit preview logs')),
      ])),
    ),
  );
}
