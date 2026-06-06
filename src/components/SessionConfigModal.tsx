import { FolderOpenOutlined, SettingOutlined } from "@ant-design/icons";
import { Button, Form, Input, InputNumber, Modal, Radio, Select } from "antd";
import { useEffect } from "react";
import type { SessionGroup, SessionInput } from "../types";

interface SessionConfigModalProps {
  open: boolean;
  mode: "create" | "edit";
  initialValue: SessionInput;
  groups: SessionGroup[];
  existingSessions: { id: string; name: string; host: string }[];
  editingSessionId?: string;
  onCancel: () => void;
  onCancelButton?: () => void;
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
  authMethod,
  proxyMode,
  existingSessions,
  editingSessionId,
}: {
  mode: "create" | "edit";
  groups: SessionGroup[];
  authMethod: "password" | "privateKey";
  proxyMode: "global" | "custom";
  existingSessions: { id: string; name: string; host: string }[];
  editingSessionId?: string;
}) {
  return (
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
        <Input placeholder="生产服务器" autoComplete="off" />
      </Form.Item>
      <Form.Item label="分组" name="groupId">
        <Select
          allowClear
          placeholder="不分组"
          options={groups.map((group) => ({ label: group.name, value: group.id }))}
        />
      </Form.Item>
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
        <Input placeholder="192.168.1.10" autoComplete="off" />
      </Form.Item>
      <Form.Item label="端口" name="port" rules={[{ required: true, message: "请输入端口" }]}>
        <InputNumber min={1} max={65535} precision={0} className="fullControl" autoComplete="off" />
      </Form.Item>
      <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
        <Input placeholder="root" autoComplete="off" />
      </Form.Item>
      {/* 认证方式与密码 - 移至基本 Tab，减少 Tab 切换 */}
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
            <Input placeholder="127.0.0.1" autoComplete="off" />
          </Form.Item>
          <Form.Item label="代理端口" name="proxyPort" className="sessionProxyPort" rules={[{ required: true, message: "请输入代理端口" }]}>
            <InputNumber min={1} max={65535} precision={0} className="fullControl" autoComplete="off" />
          </Form.Item>
        </div>
      )}
    </div>
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
        placeholder="点击浏览选择私钥文件，或手动输入路径"
        autoComplete="off"
        addonAfter={
          <Button
            type="text"
            icon={<FolderOpenOutlined />}
            onClick={browse}
            style={{ height: "100%", padding: "0 8px", margin: 0 }}
          >
            浏览
          </Button>
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
