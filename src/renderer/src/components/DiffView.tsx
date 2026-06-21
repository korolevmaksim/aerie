import type { CommitFile } from '@shared/types'

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff__line diff__line--hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff__line diff__line--add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff__line diff__line--del'
  return 'diff__line'
}

// Safety valve: a generated file (lockfile, minified bundle) can produce a
// many-thousand-line patch. Render up to this many lines, then a notice.
const MAX_DIFF_LINES = 1500

function Patch({ patch }: { patch: string }): React.JSX.Element {
  const lines = patch.split('\n')
  const shown = lines.slice(0, MAX_DIFF_LINES)
  const hidden = lines.length - shown.length
  return (
    <pre className="diff">
      {shown.map((line, i) => (
        <span key={i} className={lineClass(line)}>
          {line || ' '}
        </span>
      ))}
      {hidden > 0 && (
        <span className="diff__line diff__line--hunk">
          … {hidden} more lines — open on GitHub to see the full diff
        </span>
      )}
    </pre>
  )
}

function DiffView({ files }: { files: CommitFile[] }): React.JSX.Element {
  if (files.length === 0) return <p className="empty">No file changes.</p>
  return (
    <div className="files">
      {files.map((file) => (
        <details key={file.filename} className="file" open={files.length <= 5}>
          <summary className="file__summary">
            <span className={`file__status file__status--${file.status}`}>{file.status}</span>
            <span className="file__name">
              {file.previousFilename
                ? `${file.previousFilename} → ${file.filename}`
                : file.filename}
            </span>
            <span className="file__stat file__stat--add">+{file.additions}</span>
            <span className="file__stat file__stat--del">-{file.deletions}</span>
          </summary>
          {file.patch ? (
            <Patch patch={file.patch} />
          ) : (
            <p className="empty file__binary">No textual diff (binary or too large).</p>
          )}
        </details>
      ))}
    </div>
  )
}

export default DiffView
