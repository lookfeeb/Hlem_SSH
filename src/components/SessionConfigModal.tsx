import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  LockOutlined,
  PlusOutlined,
  SettingOutlined,
  GlobalOutlined,
  UserOutlined,
  KeyOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { Button, Form, Input, InputNumber, Modal, Radio, Select, Tooltip } from "antd";
import { useEffect, useState } from "react";
import { getGroupNameLengthError, GROUP_COUNT_ERROR, GROUP_CUSTOM_MAX_COUNT, GROUP_NAME_MAX_CHARS } from "../lib/groupName";
import type { SessionGroup, SessionInput } from "../types";

const GROUP_SELECT_OPTION_HEIGHT = 36;
const GROUP_SELECT_VISIBLE_COUNT = 5;
const GROUP_SELECT_LIST_HEIGHT = GROUP_SELECT_OPTION_HEIGHT * GROUP_SELECT_VISIBLE_COUNT;

interface SessionConfigModalProps {
  open: boolean;
  mode: "create" | "edit";
  initialValue: SessionInput;
  groups: SessionGroup[];
  existingSessions: { id: string; name: string; host: string }[];
  editingSessionId?: string;
  onCancel: () => void;
  onCancelButton?: () => void;
  onCreateGroup: (name: string) => Promise<string | null>;
  onUpdateGroup: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<string | null>;
  onSubmit: (input: SessionInput) => Promise<void>;
}

interface SessionFormValues {
  name: string;
  groupId?: string | null;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "privateKey";
  password?: string | null;
  privateKeyPath?: string | null;
  importedPrivateKey?: string | null;
  privateKeyPassphrase?: string | null;
  proxyMode: "global" | "custom";
  proxyKind: "socks5" | "httpConnect";
  proxyHost: string;
  proxyPort: number;
}

export function SessionConfigModal({
  open,
  mode,
  initialValue,
  groups,
  existingSessions,
  editingSessionId,
  onCancel,
  onCancelButton,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onSubmit,
}: SessionConfigModalProps) {
  const [form] = Form.useForm<SessionFormValues>();
  const authMethod = Form.useWatch("authMethod", form);
  const proxyMode = Form.useWatch("proxyMode", form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(toFormValues(initialValue, mode));
  }, [form, initialValue, mode, open]);

  async function submit() {
    await form.validateFields();
    const values = form.getFieldsValue(true);
    await onSubmit(toSessionInput(values, initialValue, mode));
  }

  return (
    <Modal
      title={
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 40, height: 40, background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 20, boxShadow: "0 8px 16px rgba(59,130,246,0.3)" }}>
            <SettingOutlined />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: "var(--text-primary)" }}>{mode === "create" ? "新建 SSH 连接" : "编辑 SSH 连接"}</span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>配置服务器访问凭证与终端安全选项</span>
          </div>
        </div>
      }
      open={open}
      width={720}
      centered
      transitionName=""
      maskTransitionName=""
      onCancel={onCancel}
      footer={[
        <Button key="cancel" aria-label="取消" onClick={onCancelButton ?? onCancel}>
          取消
        </Button>,
        <Button key="submit" type="primary" aria-label={mode === "create" ? "创建" : "保存"} onClick={() => void submit()}>
          {mode === "create" ? "创建" : "保存"}
        </Button>,
      ]}
      destroyOnHidden
      className="sessionConfigModal"
    >
      <Form form={form} layout="vertical" requiredMark={false} autoComplete="off">
        <BaseFields
          mode={mode}
          groups={groups}
          onCreateGroup={onCreateGroup}
          onUpdateGroup={onUpdateGroup}
          onDeleteGroup={onDeleteGroup}
          authMethod={authMethod ?? initialValue.auth.method}
          proxyMode={proxyMode ?? proxyModeFromInput(initialValue)}
          existingSessions={existingSessions}
          editingSessionId={editingSessionId}
        />
      </Form>
    </Modal>
  );
}

function BaseFields({
  mode,
  groups,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  authMethod,
  proxyMode,
  existingSessions,
  editingSessionId,
}: {
  mode: "create" | "edit";
  groups: SessionGroup[];
  onCreateGroup: (name: string) => Promise<string | null>;
  onUpdateGroup: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<string | null>;
  authMethod: "password" | "privateKey";
  proxyMode: "global" | "custom";
  existingSessions: { id: string; name: string; host: string }[];
  editingSessionId?: string;
}) {
  return (
    <>
      <div className="formSectionCard">
        <div className="formSectionTitle">服务器连接凭据</div>
        <div className="sessionFormGrid">
          <Form.Item
            label="连接名称"
            name="name"
            rules={[{
              validator: (_, value) => {
                if (!value || !value.trim()) return Promise.resolve();
                const duplicate = existingSessions.find(
                  (s) => s.name === value.trim() && s.id !== editingSessionId,
                );
                return duplicate ? Promise.reject("该名称已存在") : Promise.resolve();
              },
            }]}
          >
            <Input placeholder="生产服务器" autoComplete="off" prefix={<EditOutlined style={{ color: "var(--text-muted)" }} />} />
          </Form.Item>
          <GroupSelectField
            groups={groups}
            onCreateGroup={onCreateGroup}
            onUpdateGroup={onUpdateGroup}
            onDeleteGroup={onDeleteGroup}
          />
          <Form.Item
            label="主机地址"
            name="host"
            rules={[
              { required: true, message: "请输入主机地址" },
              {
                validator: (_, value) => {
                  if (!value || !value.trim()) return Promise.resolve();
                  const duplicate = existingSessions.find(
                    (s) => s.host === value.trim() && s.id !== editingSessionId,
                  );
                  return duplicate
                    ? Promise.reject(`该主机已存在（${duplicate.name}）`)
                    : Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="192.168.1.10" autoComplete="off" prefix={<GlobalOutlined style={{ color: "var(--text-muted)" }} />} />
          </Form.Item>
          <Form.Item label="端口" name="port" rules={[{ required: true, message: "请输入端口" }]}>
            <InputNumber min={1} max={65535} precision={0} className="fullControl" autoComplete="off" prefix={<LinkOutlined style={{ color: "var(--text-muted)" }} />} />
          </Form.Item>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input placeholder="root" autoComplete="off" prefix={<UserOutlined style={{ color: "var(--text-muted)" }} />} />
          </Form.Item>
        </div>
      </div>
      <div className="formSectionCard">
        <div className="formSectionTitle">安全认证与网络代理</div>
        <div className="sessionFormGrid">
          <Form.Item label="认证方式" name="authMethod" className="sessionFormWide">
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: "密码", value: "password" },
                { label: "私钥", value: "privateKey" },
              ]}
            />
          </Form.Item>
          {authMethod === "password" && (
            <Form.Item
              label="密码"
              name="password"
              className="sessionFormWide"
              rules={mode === "create" ? [{ required: true, message: "请输入密码" }] : undefined}
            >
              <Input.Password
                placeholder={mode === "create" ? "请输入本次连接密码" : "已保存的密码不会回显；留空则保持不变"}
                autoComplete="new-password"
                prefix={<LockOutlined style={{ color: "var(--text-muted)" }} />}
              />
            </Form.Item>
          )}
          {authMethod === "privateKey" && (
            <>
              <PrivateKeyPathField />
              <Form.Item label="私钥密码短语" name="privateKeyPassphrase" className="sessionFormWide">
                <Input.Password
                  placeholder={mode === "create" ? "如私钥有密码短语请输入" : "已保存的密码短语不会回显；留空则保持不变"}
                  autoComplete="new-password"
                  prefix={<LockOutlined style={{ color: "var(--text-muted)" }} />}
                />
              </Form.Item>
            </>
          )}
          <Form.Item label="代理策略" name="proxyMode" className="sessionFormWide">
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: "跟随系统", value: "global" },
                { label: "单独指定", value: "custom" },
              ]}
            />
          </Form.Item>
          {proxyMode === "custom" && (
            <div className="sessionProxyInline sessionFormWide">
              <Form.Item label="代理类型" name="proxyKind" className="sessionProxyKind">
                <Select
                  options={[
                    { label: "SOCKS5", value: "socks5" },
                    { label: "HTTP CONNECT", value: "httpConnect" },
                  ]}
                />
              </Form.Item>
              <Form.Item label="代理主机" name="proxyHost" className="sessionProxyHost" rules={[{ required: true, message: "请输入代理主机" }]}>
                <Input placeholder="127.0.0.1" autoComplete="off" prefix={<GlobalOutlined style={{ color: "var(--text-muted)" }} />} />
              </Form.Item>
              <Form.Item label="代理端口" name="proxyPort" className="sessionProxyPort" rules={[{ required: true, message: "请输入代理端口" }]}>
                <InputNumber min={1} max={65535} precision={0} className="fullControl" autoComplete="off" prefix={<LinkOutlined style={{ color: "var(--text-muted)" }} />} />
              </Form.Item>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function GroupSelectField({
  groups,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
}: {
  groups: SessionGroup[];
  onCreateGroup: (name: string) => Promise<string | null>;
  onUpdateGroup: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<string | null>;
}) {
  const form = Form.useFormInstance<SessionFormValues>();
  const [newGroupName, setNewGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [groupActionError, setGroupActionError] = useState<string | null>(null);
  const [groupNameOverrides, setGroupNameOverrides] = useState<Record<string, string>>({});
  const trimmedName = newGroupName.trim();
  const newGroupNameLengthError = getGroupNameLengthError(trimmedName);
  const editingGroupNameLengthError = editingGroupId ? getGroupNameLengthError(editingGroupName) : null;
  const defaultGroupId = groups.find((group) => group.sortOrder === 0)?.id ?? groups[0]?.id ?? null;
  const customGroupCount = groups.filter((group) => group.id !== defaultGroupId).length;
  const existingGroupForNewName = groups.find((group) => getGroupDisplayName(group) === trimmedName);
  const newGroupCountError =
    trimmedName && !existingGroupForNewName && customGroupCount >= GROUP_CUSTOM_MAX_COUNT ? GROUP_COUNT_ERROR : null;
  const groupOptions = groups.map((group) => ({
    label: getGroupDisplayName(group),
    value: group.id,
    group,
  }));
  const groupSelectKey = groupOptions.map((option) => `${option.value}:${option.label}`).join("|");

  useEffect(() => {
    setGroupNameOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const [groupId, name] of Object.entries(current)) {
        const group = groups.find((item) => item.id === groupId);
        if (!group || group.name === name) {
          delete next[groupId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [groups]);

  function isDefaultGroup(group: SessionGroup) {
    return group.id === defaultGroupId;
  }

  function getGroupDisplayName(group: SessionGroup) {
    return groupNameOverrides[group.id] ?? group.name;
  }

  async function createGroup() {
    if (!trimmedName || creating) return;
    if (newGroupNameLengthError) {
      setCreateError(newGroupNameLengthError);
      return;
    }
    if (existingGroupForNewName) {
      form.setFieldValue("groupId", existingGroupForNewName.id);
      setNewGroupName("");
      setCreateError(null);
      return;
    }
    if (newGroupCountError) {
      setCreateError(newGroupCountError);
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const groupId = await onCreateGroup(trimmedName);
      if (groupId) form.setFieldValue("groupId", groupId);
      setNewGroupName("");
      setGroupActionError(null);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "创建分组失败");
    } finally {
      setCreating(false);
    }
  }

  async function updateGroup(group: SessionGroup) {
    const nextName = editingGroupName.trim();
    if (!nextName || busyGroupId) return;
    const lengthError = getGroupNameLengthError(nextName);
    if (lengthError) {
      setGroupActionError(lengthError);
      return;
    }
    if (nextName === getGroupDisplayName(group)) {
      setEditingGroupId(null);
      setEditingGroupName("");
      return;
    }
    const existingGroup = groups.find((item) => item.id !== group.id && getGroupDisplayName(item) === nextName);
    if (existingGroup) {
      form.setFieldValue("groupId", existingGroup.id);
      setEditingGroupId(null);
      setEditingGroupName("");
      setGroupActionError(null);
      return;
    }

    setBusyGroupId(group.id);
    setGroupActionError(null);
    try {
      await onUpdateGroup(group.id, nextName);
      setGroupNameOverrides((current) => ({ ...current, [group.id]: nextName }));
      if (form.getFieldValue("groupId") === group.id) {
        form.setFieldValue("groupId", group.id);
      }
      setEditingGroupId(null);
      setEditingGroupName("");
    } catch (error) {
      setGroupActionError(error instanceof Error ? error.message : "重命名分组失败");
    } finally {
      setBusyGroupId(null);
    }
  }

  async function deleteGroup(group: SessionGroup) {
    if (busyGroupId) return;
    setBusyGroupId(group.id);
    setGroupActionError(null);
    try {
      const fallbackGroupId = await onDeleteGroup(group.id);
      if (form.getFieldValue("groupId") === group.id) {
        form.setFieldValue("groupId", fallbackGroupId);
      }
      setConfirmDeleteGroupId(null);
      setEditingGroupId(null);
      setEditingGroupName("");
    } catch (error) {
      setGroupActionError(error instanceof Error ? error.message : "删除分组失败");
    } finally {
      setBusyGroupId(null);
    }
  }

  function startEdit(group: SessionGroup) {
    setEditingGroupId(group.id);
    setEditingGroupName(getGroupDisplayName(group));
    setConfirmDeleteGroupId(null);
    setGroupActionError(null);
  }

  function resetTransientGroupState() {
    setEditingGroupId(null);
    setEditingGroupName("");
    setConfirmDeleteGroupId(null);
    setGroupActionError(null);
  }

  function renderGroupOption(group: SessionGroup) {
    const defaultGroup = isDefaultGroup(group);
    const editing = editingGroupId === group.id;
    const confirmingDelete = confirmDeleteGroupId === group.id;
    const busy = busyGroupId === group.id;

    if (editing) {
      return (
        <div className="sessionGroupOption sessionGroupOption-editing" onMouseDown={(event) => event.stopPropagation()}>
          <Input
            className="sessionGroupRenameInput"
            value={editingGroupName}
            autoFocus
            maxLength={GROUP_NAME_MAX_CHARS}
            onChange={(event) => {
              setEditingGroupName(event.target.value);
              setGroupActionError(null);
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                void updateGroup(group);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setEditingGroupId(null);
                setEditingGroupName("");
              }
            }}
          />
          <span className="sessionGroupOptionActions">
            <Tooltip title="保存">
              <Button
                aria-label="保存分组名称"
                className="sessionGroupOptionButton sessionGroupOptionButton-save"
                type="text"
                icon={<CheckOutlined />}
                loading={busy}
                disabled={!editingGroupName.trim() || !!editingGroupNameLengthError}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void updateGroup(group);
                }}
              />
            </Tooltip>
            <Tooltip title="取消">
              <Button
                aria-label="取消重命名"
                className="sessionGroupOptionButton"
                type="text"
                icon={<CloseOutlined />}
                disabled={busy}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditingGroupId(null);
                  setEditingGroupName("");
                }}
              />
            </Tooltip>
          </span>
        </div>
      );
    }

    return (
      <div className={`sessionGroupOption${defaultGroup ? " sessionGroupOption-default" : ""}`}>
        <span className="sessionGroupOptionName">{getGroupDisplayName(group)}</span>
        <span className="sessionGroupOptionActions" onMouseDown={(event) => event.stopPropagation()}>
          {defaultGroup ? (
            <Tooltip title="默认分组不可重命名或删除">
              <span className="sessionGroupLockIcon" aria-label="默认分组锁定">
                <LockOutlined />
              </span>
            </Tooltip>
          ) : confirmingDelete ? (
            <>
              <Tooltip title="删除">
                <Button
                  aria-label="确认删除分组"
                  className="sessionGroupOptionButton sessionGroupOptionButton-danger"
                  type="text"
                  icon={<CheckOutlined />}
                  loading={busy}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void deleteGroup(group);
                  }}
                />
              </Tooltip>
              <Tooltip title="取消">
                <Button
                  aria-label="取消删除分组"
                  className="sessionGroupOptionButton"
                  type="text"
                  icon={<CloseOutlined />}
                  disabled={busy}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirmDeleteGroupId(null);
                  }}
                />
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip title="重命名">
                <Button
                  aria-label={`重命名 ${getGroupDisplayName(group)}`}
                  className="sessionGroupOptionButton"
                  type="text"
                  icon={<EditOutlined />}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    startEdit(group);
                  }}
                />
              </Tooltip>
              <Tooltip title="删除">
                <Button
                  aria-label={`删除 ${getGroupDisplayName(group)}`}
                  className="sessionGroupOptionButton sessionGroupOptionButton-danger"
                  type="text"
                  icon={<DeleteOutlined />}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirmDeleteGroupId(group.id);
                    setEditingGroupId(null);
                    setGroupActionError(null);
                  }}
                />
              </Tooltip>
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <Form.Item label="分组" name="groupId">
      <Select
        key={groupSelectKey}
        allowClear
        classNames={{ popup: { root: "sessionGroupSelectPopup" } }}
        listHeight={GROUP_SELECT_LIST_HEIGHT}
        onOpenChange={(open) => {
          if (!open) resetTransientGroupState();
        }}
        placeholder="不分组"
        options={groupOptions}
        optionRender={(option) => renderGroupOption(option.data.group as SessionGroup)}
        popupRender={(menu) => (
          <>
            {menu}
            {groupActionError && <div className="sessionGroupActionError">{groupActionError}</div>}
            {editingGroupNameLengthError && <div className="sessionGroupActionError">{editingGroupNameLengthError}</div>}
            <div className="sessionGroupCreatePanel" onMouseDown={(event) => event.stopPropagation()}>
              <Input
                className="sessionGroupCreateInput"
                placeholder="新分组名称"
                value={newGroupName}
                maxLength={GROUP_NAME_MAX_CHARS}
                onChange={(event) => {
                  setNewGroupName(event.target.value);
                  setCreateError(null);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createGroup();
                  }
                }}
              />
              <Tooltip title="新建分组">
                <Button
                  aria-label="新建分组"
                  className="sessionGroupCreateButton"
                  type="text"
                  icon={<PlusOutlined />}
                  loading={creating}
                  disabled={!trimmedName || !!newGroupNameLengthError || !!newGroupCountError}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void createGroup();
                  }}
                />
              </Tooltip>
              {(createError || newGroupNameLengthError || newGroupCountError) && (
                <div className="sessionGroupCreateError">{createError || newGroupNameLengthError || newGroupCountError}</div>
              )}
            </div>
          </>
        )}
      />
    </Form.Item>
  );
}

/** 私钥路径字段：含系统文件选择器按钮（Tauri dialog） */
function PrivateKeyPathField() {
  const form = Form.useFormInstance();

  async function browse() {
    try {
      // 动态导入，避免在非 Tauri 环境中报错
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "选择私钥文件",
        multiple: false,
        filters: [
          { name: "私钥文件", extensions: ["pem", "key", "ppk", "rsa", "ed25519"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (typeof selected === "string" && selected) {
        form.setFieldValue("privateKeyPath", selected);
      }
    } catch {
      // 插件不可用时用户可手动输入路径
    }
  }

  return (
    <Form.Item label="私钥文件路径" name="privateKeyPath" className="sessionFormWide">
      <Input
        className="privateKeyPathInput"
        placeholder="选择或输入私钥文件路径"
        autoComplete="off"
        prefix={<KeyOutlined style={{ color: "var(--text-muted)" }} />}
        suffix={
          <Tooltip title="浏览私钥文件">
            <Button
              aria-label="浏览私钥文件"
              className="privateKeyBrowseButton"
              type="text"
              icon={<FolderOpenOutlined />}
              onClick={browse}
            />
          </Tooltip>
        }
      />
    </Form.Item>
  );
}

function toFormValues(input: SessionInput, mode: "create" | "edit"): SessionFormValues {
  const proxy = input.ssh.proxy;
  return {
    name: mode === "create" ? "" : input.name,
    groupId: input.groupId ?? null,
    host: mode === "create" ? "" : input.host,
    port: input.port,
    username: mode === "create" ? "root" : input.username,
    authMethod: mode === "create" ? "password" : input.auth.method,
    password: null,
    privateKeyPath: mode === "create" ? null : input.auth.privateKeyPath ?? null,
    importedPrivateKey: mode === "create" ? null : input.auth.importedPrivateKey ?? null,
    privateKeyPassphrase: null,
    proxyMode: proxyModeFromInput(input),
    proxyKind: proxy?.kind === "httpConnect" ? "httpConnect" : "socks5",
    proxyHost: proxy?.host || "127.0.0.1",
    proxyPort: proxy?.port || 1080,
  };
}

function toSessionInput(values: SessionFormValues, previous: SessionInput, mode: "create" | "edit"): SessionInput {
  const password = cleanOptional(values.password);
  const privateKeyPassphrase = cleanOptional(values.privateKeyPassphrase);
  const auth =
    values.authMethod === "privateKey"
      ? {
          method: "privateKey" as const,
          password: null,
          privateKeyPath: cleanOptional(values.privateKeyPath),
          importedPrivateKey: cleanOptional(values.importedPrivateKey),
          privateKeyPassphrase:
            privateKeyPassphrase ??
            (mode === "edit" && previous.auth.method === "privateKey" ? previous.auth.privateKeyPassphrase ?? null : null),
        }
      : {
          method: "password" as const,
          password: password ?? (mode === "edit" && previous.auth.method === "password" ? previous.auth.password ?? null : null),
          privateKeyPath: null,
          importedPrivateKey: null,
          privateKeyPassphrase: null,
        };

  return {
    name: values.name.trim(),
    groupId: values.groupId ?? null,
    host: values.host.trim(),
    port: values.port,
    username: values.username.trim(),
    auth,
    ssh: {
      ...previous.ssh,
      connectTimeoutMs: 10000,
      keepaliveIntervalSec: 15,
      proxy: proxyFromValues(values),
    },
    defaultPath: "",
    tags: previous.tags,
    note: previous.note ?? null,
    terminal: {
      ...previous.terminal,
      encoding: "utf-8",
      theme: "default",
      keepaliveIntervalSec: 15,
    },
    sftp: {
      ...previous.sftp,
      defaultPath: "",
      showHidden: false,
    },
  };
}

function cleanOptional(value?: string | null): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function proxyModeFromInput(input: SessionInput): SessionFormValues["proxyMode"] {
  const proxy = input.ssh.proxy;
  if (!proxy) return "global";
  if (proxy.kind === "direct") return "global";
  return "custom";
}

function proxyFromValues(values: SessionFormValues): SessionInput["ssh"]["proxy"] {
  if (values.proxyMode === "global") return null;
  return {
    kind: values.proxyKind,
    host: values.proxyHost.trim(),
    port: values.proxyPort,
  };
}
