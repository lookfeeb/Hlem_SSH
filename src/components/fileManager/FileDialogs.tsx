import { Form, Input, Modal, Radio, Tree } from "antd";
import { ArrowRightOutlined, CopyOutlined, EditOutlined, FolderAddOutlined, InfoCircleOutlined, SwapOutlined } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import type { RemoteFileEntry } from "../../types";

export type FileDialogState =
  | { kind: "create"; entryType: "file" | "directory"; name: string }
  | { kind: "rename"; entry: RemoteFileEntry; value: string }
  | { kind: "copy"; entry: RemoteFileEntry; value: string }
  | { kind: "move"; entry: RemoteFileEntry; value: string };

export interface FileDialogsProps {
  dialog: FileDialogState | null;
  treeData: DataNode[];
  directoryExpandedKeys: string[];
  onDialogChange: (dialog: FileDialogState | null) => void;
  onSubmit: () => void;
  onLoadDirectory: (path: string) => void;
  onExpandChange: (keys: string[]) => void;
  onTreeSelect: (path: string) => void;
}

export function FileDialogs({
  dialog,
  treeData,
  directoryExpandedKeys,
  onDialogChange,
  onSubmit,
  onLoadDirectory,
  onExpandChange,
  onTreeSelect,
}: FileDialogsProps) {
  return (
    <Modal
      open={Boolean(dialog)}
      title={dialogTitle(dialog)}
      okText="执行"
      cancelText="取消"
      onCancel={() => onDialogChange(null)}
      onOk={onSubmit}
      destroyOnHidden
      className="fileOperationModal"
    >
      {dialog?.kind === "create" && (
        <Form layout="vertical">
          <Form.Item label="类型">
            <Radio.Group
              value={dialog.entryType}
              onChange={(event) => onDialogChange({ ...dialog, entryType: event.target.value })}
              options={[
                { label: "文件", value: "file" },
                { label: "目录", value: "directory" },
              ]}
            />
          </Form.Item>
          <Form.Item label="名称">
            <Input
              autoFocus
              placeholder={dialog.entryType === "file" ? "new-file.txt" : "new-folder"}
              value={dialog.name}
              onChange={(event) => onDialogChange({ ...dialog, name: event.target.value })}
              onPressEnter={onSubmit}
            />
          </Form.Item>
        </Form>
      )}
      {dialog?.kind === "rename" && (
        <Form layout="vertical">
          <Form.Item label="新名称">
            <Input
              autoFocus
              value={dialog.value}
              onChange={(event) => onDialogChange({ ...dialog, value: event.target.value })}
              onPressEnter={onSubmit}
            />
          </Form.Item>
        </Form>
      )}
      {(dialog?.kind === "copy" || dialog?.kind === "move") && (
        <Form layout="vertical" className="fileOperationForm">
          {/* 路径流向卡片 */}
          <div className="fileOperationFlow">
            <div className="flowNode sourceNode">
              <span className="nodeIcon">📄</span>
              <span className="nodeText" title={dialog.entry.name}>
                {dialog.entry.name}
              </span>
            </div>
            <div className="flowConnector">
              <ArrowRightOutlined className="flowArrowIcon" />
            </div>
            <div className="flowNode targetNode" key={dialog.value}>
              <span className="nodeIcon">📁</span>
              <span className="nodeText" title={dialog.value || "/"}>
                {dialog.value.split("/").filter(Boolean).pop() || "根目录"}
              </span>
            </div>
          </div>

          {/* 目录树卡片 */}
          <div className="fileOperationTreeContainer">
            <div className="treeHeader">选择目标目录</div>
            <div className="fileOperationTree">
            <Tree
              showIcon
              blockNode
              virtual
              expandAction={false}
              selectedKeys={[dialog.value]}
              expandedKeys={directoryExpandedKeys}
              treeData={treeData}
              switcherIcon={({ isLeaf }) => (isLeaf ? null : <span className="pathTreeChevron" />)}
              loadData={(node) => {
                onLoadDirectory(String(node.key));
                return Promise.resolve();
              }}
              onExpand={(keys, info) => {
                onExpandChange(keys.map(String));
                if (info.expanded) onLoadDirectory(String(info.node.key));
              }}
              onClick={(event, node) => {
                if (isTreeSwitcherClick(event.target)) return;
                onTreeSelect(String(node.key));
              }}
            />
          </div>
        </div>
        <Form.Item className="fileOperationPathItem">
          <Input
            autoFocus
            prefix={<FolderAddOutlined className="pathInputIcon" />}
            placeholder="目标目录"
            value={dialog.value}
            onChange={(event) => onDialogChange({ ...dialog, value: event.target.value })}
            onPressEnter={onSubmit}
          />
        </Form.Item>
        <div className="fileOperationHintCard">
          <InfoCircleOutlined className="hintIcon" />
          <span className="hintText">可以从目录树选择，也可以手动编辑输入完整目标路径。</span>
        </div>
        </Form>
      )}
    </Modal>
  );
}

function dialogTitle(dialog: FileDialogState | null) {
  if (!dialog) return null;
  const iconStyle = { marginRight: 8, color: "var(--accent-2)" };
  if (dialog.kind === "create") {
    return (
      <span className="fileDialogTitle">
        <FolderAddOutlined style={iconStyle} />
        新建文件或目录
      </span>
    );
  }
  if (dialog.kind === "rename") {
    return (
      <span className="fileDialogTitle">
        <EditOutlined style={iconStyle} />
        重命名
      </span>
    );
  }
  if (dialog.kind === "copy") {
    return (
      <span className="fileDialogTitle">
        <CopyOutlined style={iconStyle} />
        复制到
      </span>
    );
  }
  return (
    <span className="fileDialogTitle">
      <SwapOutlined style={iconStyle} />
      移动到
    </span>
  );
}

function isTreeSwitcherClick(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest(".ant-tree-switcher"));
}

export function operationLabel(operation: { kind: string; entryType?: string }) {
  if (operation.kind === "create") return operation.entryType === "directory" ? "新建目录" : "新建文件";
  if (operation.kind === "rename") return "重命名";
  if (operation.kind === "copy") return "复制";
  if (operation.kind === "move") return "移动";
  return "删除";
}
