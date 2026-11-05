import Editor from "@monaco-editor/react";
import "@/lib/monaco";

export function CodeViewer({ value, language = "javascript", path }: { value: string; language?: string; path?: string }) {
  return (
    <Editor
      value={value}
      language={language}
      path={path}
      theme="agentos"
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
        fontSize: 12.5,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        padding: { top: 12, bottom: 12 },
        wordWrap: "on",
        smoothScrolling: true,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        stickyScroll: { enabled: false }
      }}
      loading={<div className="p-4 font-mono text-xs text-faint">Loading editor…</div>}
    />
  );
}
