/**
 * Bundle Monaco locally (no CDN) and register the AgentOS theme.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    if (label === "json") return new JsonWorker();
    return new EditorWorker();
  }
};

monaco.editor.defineTheme("agentos", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6b6e64", fontStyle: "italic" },
    { token: "keyword", foreground: "d7ff64" },
    { token: "string", foreground: "c9e7a1" },
    { token: "number", foreground: "ffb547" },
    { token: "identifier", foreground: "f5f5f0" },
    { token: "type", foreground: "7cc7ff" },
    { token: "delimiter", foreground: "9a9d92" }
  ],
  colors: {
    "editor.background": "#0b0c0a",
    "editor.foreground": "#f5f5f0",
    "editorLineNumber.foreground": "#3a3f36",
    "editorLineNumber.activeForeground": "#9a9d92",
    "editor.lineHighlightBackground": "#171915",
    "editor.selectionBackground": "#d7ff6430",
    "editorCursor.foreground": "#d7ff64",
    "editorIndentGuide.background1": "#1d201b",
    "editorWidget.background": "#171915",
    "scrollbarSlider.background": "#3a3f3655"
  }
});


loader.config({ monaco });
