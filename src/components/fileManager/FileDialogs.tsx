import { Form, Input, Modal, Radio, Tree } from "antd";
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CopyOutlined,
  EditOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  InfoCircleOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import type { RemoteFileEntry } from "../../types";
import { getBaseName } from "../../lib/path";

export type FileDialogState =
  | { kind: "create"; entryType: "file" | "directory"; name: string }
  | { kind: "rename"; entry: RemoteFileEntry; value: string }
  | { kind: "copy"; entry: RemoteFileEntry; value: string }
  | { kind: "move"; entry: RemoteFileEntry; value: string };

export interface FileDialogsProps {
  dialog: FileDialogState | null;
  currentPath: string;
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
  currentPath,
  treeData,
  directoryExpandedKeys,
  onDialogChange,
  onSubmit,
  onLoadDirectory,
  onExpandChange,
  onTreeSelect,
}: FileDialogsProps) {
  const createDialog = dialog?.kind === "create" ? dialog : null;
  const createLabel = createDialog?.entryType === "directory" ? "新建目录" : "新建文件";

  return (
    <Modal
      open={Boolean(dialog)}
      title={dialogTitle(dialog)}
      okText={createDialog ? createLabel : dialog?.kind === "rename" ? "保存" : "执行"}
      cancelText="取消"
      width={createDialog ? 540 : undefined}
      centered={Boolean(createDialog)}
      onCancel={() => onDialogChange(null)}
      onOk={onSubmit}
      okButtonProps={createDialog ? {
        disabled: !createDialog.name.trim(),
        icon: createDialog.entryType === "directory" ? <FolderAddOutlined /> : <FileAddOutlined />,
      } : undefined}
      destroyOnHidden
      className={`fileOperationModal ${createDialog ? "fileCreateModal" : ""}`}
    >
      {createDialog && (
        <Form layout="vertical" className="fileCreateForm">
          <Form.Item
            className="fileCreateTypeItem"
            label={(
              <span className="fileCreateFieldHeading">
                <strong>创建类型</strong>
                <small>选择要添加到当前目录的项目</small>
              </span>
            )}
          >
            <Radio.Group
              className="fileCreateTypePicker"
              value={createDialog.entryType}
              onChange={(event) => onDialogChange({ ...createDialog, entryType: event.target.value })}
            >
              <Radio value="file">
                <span className="fileCreateTypeIcon"><FileTextOutlined /></span>
                <span className="fileCreateTypeCopy">
                  <strong>文件</strong>
                  <small>配置、脚本或文本内容</small>
                </span>
                <CheckCircleFilled className="fileCreateTypeSelected" />
              </Radio>
              <Radio value="directory">
                <span className="fileCreateTypeIcon"><FolderOutlined /></span>
                <span className="fileCreateTypeCopy">
                  <strong>目录</strong>
                  <small>用于整理文件和子目录</small>
                </span>
                <CheckCircleFilled className="fileCreateTypeSelected" />
              </Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            className="fileCreateNameItem"
            label={(
              <span className="fileCreateFieldHeading">
                <strong>{createDialog.entryType === "file" ? "文件名称" : "目录名称"}</strong>
                <small>请输入清晰且易识别的名称</small>
              </span>
            )}
          >
            <Input
              autoFocus
              allowClear
              size="large"
              className="fileCreateNameInput"
              prefix={createDialog.entryType === "file" ? <FileTextOutlined /> : <FolderOutlined />}
              placeholder={createDialog.entryType === "file" ? "例如：config.yaml" : "例如：uploads"}
              value={createDialog.name}
              onChange={(event) => onDialogChange({ ...createDialog, name: event.target.value })}
              onPressEnter={onSubmit}
            />
          </Form.Item>
          <div className="fileCreateLocation" title={currentPath || "/"}>
            <span className="fileCreateLocationIcon"><FolderOpenOutlined /></span>
            <span className="fileCreateLocationCopy">
              <small>创建位置</small>
              <code>{currentPath || "/"}</code>
            </span>
          </div>
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
                {getBaseName(dialog.value) || "根目录"}
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
      <span className="fileDialogTitle fileDialogTitleDetailed">
        <span className="fileDialogTitleIcon"><FolderAddOutlined /></span>
        <span className="fileDialogTitleCopy">
          <strong>新建文件或目录</strong>
          <small>在当前远程路径中添加新项目</small>
        </span>
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
