import type { ToolCall } from '../hooks/useChatMessages';
import { buildToolCallDetailSections } from '../utils/tool-call-detail';

export function ToolCallDetailBody({ tool }: { tool: ToolCall }) {
  const sections = buildToolCallDetailSections(tool);
  if (sections.length === 0) return null;

  return (
    <div className="tool-call-detail-body">
      {sections.map((section, index) => {
        if (section.kind === 'heading') {
          return (
            <div key={`heading-${index}`} className="tool-call-detail-heading">
              {section.label !== undefined && <strong>{section.label}</strong>}
              {section.text !== undefined && <span>{section.text}</span>}
            </div>
          );
        }

        const label = section.label;
        if (section.kind === 'diff' && section.lines !== undefined) {
          return (
            <section key={`diff-${index}`} className="tool-call-detail-section">
              {label !== undefined && <header>{label}</header>}
              <pre className="compact-diff tool-call-detail-diff">
                {section.lines.map((line, lineIndex) => (
                  <span
                    key={`${lineIndex}-${line}`}
                    className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : undefined}
                  >
                    {line}
                  </span>
                ))}
              </pre>
            </section>
          );
        }

        const text = section.text ?? '';
        const tone = section.kind === 'error' ? 'error' : 'pre';
        return (
          <section key={`${tone}-${index}`} className={`tool-call-detail-section tool-call-detail-${tone}`}>
            {label !== undefined && <header>{label}</header>}
            <pre>{text}</pre>
          </section>
        );
      })}
    </div>
  );
}
