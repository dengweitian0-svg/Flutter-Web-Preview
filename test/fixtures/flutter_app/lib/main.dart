import 'package:flutter/material.dart';

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
      body: const Center(child: Text('Preview version 1')),
    ),
  );
}
