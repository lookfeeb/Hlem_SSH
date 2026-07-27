import { CalendarOutlined, CloudDownloadOutlined, EyeInvisibleOutlined, FileTextOutlined, RocketOutlined } from "@ant-design/icons";
import { Button, Modal } from "antd";
import type { ReactNode } from "react";
import { formatBeijingDate } from "../../lib/format";
import type { UpdateInfo } from "../../types";

interface ReleaseNotesModalProps {
  open: boolean;
  onClose: () => void;
  updateInfo: UpdateInfo | null;
  updateDownloading: boolean;
  onDownloadUpdate: () => Promise<void>;
  onIgnoreUpdate: () => Promise<void>;
}

export function ReleaseNotesModal({ open, onClose, updateInfo, updateDownloading, onDownloadUpdate, onIgnoreUpdate }: ReleaseNotesModalProps) {
  const canDownloadUpdate = Boolean(updateInfo?.hasUpdate && updateInfo.asset);
  const versionLabel = updateInfo?.tagName || (updateInfo?.latestVersion ? `v${updateInfo.latestVersion}` : "--");

  return (
    <Modal open={open} title={null} className="releaseNotesModal" footer={null} onCancel={onClose} destroyOnHidden width={680} centered>
      <div className="releaseNotesModalShell">
        <header className="releaseNotesHeader">
          <span className="releaseNotesHeaderIcon" aria-hidden="true"><RocketOutlined /></span>
          <div className="releaseNotesHeaderCopy">
            <strong>版本更新记录</strong>
            <span>查看本次发布包含的功能、优化与修复</span>
          </div>
          <div className="releaseNotesHeaderMeta">
            <strong className="releaseNotesVersionTag">{versionLabel}</strong>
            {updateInfo?.publishedAt ? <span className="releaseNotesDate"><CalendarOutlined />{formatBeijingDate(updateInfo.publishedAt)}</span> : null}
          </div>
        </header>

        <main className="releaseNotesMain">
          <div className={`releaseNotesOverview ${updateInfo?.hasUpdate ? "has-update" : "is-current"}`}>
            <span className="releaseNotesOverviewDot" aria-hidden="true" />
            <div>
              <strong>{updateInfo?.hasUpdate ? `新版本 ${versionLabel} 已可用` : `${versionLabel} 版本记录`}</strong>
              <span>{updateInfo?.asset?.name ?? "内容来自 GitHub Release 发布说明"}</span>
            </div>
          </div>
          <div className="releaseNotesBody">{renderReleaseNotes(updateInfo)}</div>
        </main>

        <footer className="releaseNotesFooter">
          <div className="releaseNotesFooterHint"><FileTextOutlined /><span>更新内容来自项目发布记录</span></div>
          <div className="releaseNotesFooterActions">
            {updateInfo?.hasUpdate ? (
              <>
                <Button className="releaseNotesCloseBtn" onClick={onClose}>稍后处理</Button>
                <Button className="releaseNotesIgnoreBtn" icon={<EyeInvisibleOutlined />} onClick={() => { void onIgnoreUpdate(); onClose(); }}>忽略此版本</Button>
                <Button className="aboutUpdateBtn releaseNotesDownloadBtn" type="primary" icon={<CloudDownloadOutlined />} loading={updateDownloading} disabled={!canDownloadUpdate} onClick={() => { void onDownloadUpdate(); onClose(); }}>下载更新</Button>
              </>
            ) : <Button className="releaseNotesCloseBtn is-primary" type="primary" onClick={onClose}>完成</Button>}
          </div>
        </footer>
      </div>
    </Modal>
  );
}

type ReleaseNotesBlock = { type: "heading"; level: 2 | 3; text: string } | { type: "list"; items: string[] } | { type: "paragraph"; text: string };

function parseReleaseNotesMarkdown(body: string): ReleaseNotesBlock[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReleaseNotesBlock[] = [];
  let currentList: string[] | null = null;
  let currentParagraph: string[] | null = null;
  const flushList = () => { if (currentList?.length) blocks.push({ type: "list", items: currentList }); currentList = null; };
  const flushParagraph = () => { if (currentParagraph?.length) blocks.push({ type: "paragraph", text: currentParagraph.join(" ") }); currentParagraph = null; };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); flushParagraph(); continue; }
    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (h3) { flushList(); flushParagraph(); blocks.push({ type: "heading", level: 3, text: h3[1] }); continue; }
    if (h2) { flushList(); flushParagraph(); blocks.push({ type: "heading", level: 2, text: h2[1] }); continue; }
    if (listItem) { flushParagraph(); currentList ??= []; currentList.push(listItem[1]); continue; }
    flushList(); currentParagraph ??= []; currentParagraph.push(line);
  }
  flushList(); flushParagraph();
  return blocks;
}

function renderInline(text: string) {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("`")) nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderReleaseNotes(updateInfo: UpdateInfo | null) {
  const body = updateInfo?.body?.trim();
  if (!body) return <div className="releaseNotesEmpty">当前版本没有填写更新日志。</div>;
  const blocks = parseReleaseNotesMarkdown(body);
  return (
    <div className="releaseNotesContent">
      {blocks.map((block, i) => {
        if (block.type === "heading") { const Tag = block.level === 2 ? "h3" : "h4"; return <Tag key={i} className={`releaseNotesHeading releaseNotesHeading--h${block.level}`}>{renderInline(block.text)}</Tag>; }
        if (block.type === "list") return <ul key={i} className="releaseNotesList">{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ul>;
        return <p key={i} className="releaseNotesParagraph">{renderInline(block.text)}</p>;
      })}
    </div>
  );
}
