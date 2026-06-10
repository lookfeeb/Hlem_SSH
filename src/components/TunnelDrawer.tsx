import { ApartmentOutlined, CopyOutlined, DeleteOutlined, EditOutlined, GlobalOutlined, LinkOutlined, NodeIndexOutlined, PlayCircleOutlined, PlusOutlined, StopOutlined, SwapOutlined, TagOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import { getErrorMessage } from "../lib/configMapping";
import type { ForwardInfo, RemoteSession, TunnelConfig, TunnelInput } from "../types";

interface TunnelDrawerProps {
  open: boolean;
  sessions: RemoteSession[];
  tunnels: TunnelConfig[];
  forwards: ForwardInfo[];
  onClose: () => void;
  onCreate: (input: TunnelInput) => Promise<void>;
  onUpdate: (id: string, input: TunnelInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onStart: (tunnel: TunnelConfig) => Promise<void>;
  onStop: (forwardId: string) => Promise<void>;
}

type TunnelModalState = { mode: "create"; value?: TunnelConfig } | { mode: "edit"; value: TunnelConfig };

export function TunnelDrawer({
  open,
  sessions,
  tunnels,
  forwards,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onStart,
  onStop,
}: TunnelDrawerProps) {
  const { message, modal } = AntdApp.useApp();
  const [editing, setEditing] = useState<TunnelModalState | null>(null);

  const tunnelColumns: ColumnsType<TunnelConfig> = [
    { title: "名称", dataIndex: "name", ellipsis: true },
    { title: "类型", width: 80, render: (_, tunnel) => forwardTypeLabel(tunnel.forwardType) },
    { title: "会话", width: 120, render: (_, tunnel) => sessions.find((session) => session.id === tunnel.sessionId)?.name ?? "未知会话" },
    { title: "监听", width: 150, render: (_, tunnel) => `${tunnel.bindHost}:${tunnel.bindPort}` },
    { title: "目标", width: 150, render: (_, tunnel) => tunnel.forwardType === "dynamic" ? "SOCKS5" : `${tunnel.targetHost}:${tunnel.targetPort}` },
    {
      title: "操作",
      width: 148,
      render: (_, tunnel) => {
        const running = forwards.find((forward) => forwardMatchesTunnel(forward, tunnel));
        return (
          <Space size={4}>
            {running ? (
              <Tooltip title="停止">
                <Button aria-label="停止" size="small" icon={<StopOutlined />} onClick={() => void onStop(running.forwardId)} />
              </Tooltip>
            ) : (
              <Tooltip title="启动">
                <Button aria-label="启动" size="small" icon={<PlayCircleOutlined />} onClick={() => void startTunnel(tunnel)} />
              </Tooltip>
            )}
            <Tooltip title="编辑">
              <Button aria-label="编辑" size="small" icon={<EditOutlined />} onClick={() => setEditing({ mode: "edit", value: tunnel })} />
            </Tooltip>
            <Tooltip title="删除">
              <Button aria-label="删除" size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(tunnel)} />
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  const forwardColumns: ColumnsType<ForwardInfo> = [
    { title: "类型", width: 80, render: (_, forward) => forwardTypeLabel(forward.forwardType) },
    { title: "监听", render: (_, forward) => `${forward.bindHost}:${forward.bindPort}` },
    { title: "目标", render: (_, forward) => forward.forwardType === "dynamic" ? "SOCKS5" : `${forward.targetHost}:${forward.targetPort}` },
    {
      title: "状态",
      width: 90,
      render: (_, forward) => {
        const isRunning = forward.status === "running";
        return (
          <span className={`tunnelStatusBadge ${isRunning ? "tunnelStatusBadge-running" : "tunnelStatusBadge-stopped"}`}>
            {isRunning ? "运行中" : "已停止"}
          </span>
        );
      },
    },
    {
      title: "操作",
      width: 112,
      render: (_, forward) => (
        <Space size={4}>
          <Tooltip title="复制监听地址">
            <Button aria-label="复制监听地址" size="small" icon={<CopyOutlined />} onClick={() => void copyBindAddress(forward)} />
          </Tooltip>
          <Tooltip title="停止">
            <Button aria-label="停止" size="small" icon={<StopOutlined />} onClick={() => void onStop(forward.forwardId)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  async function startTunnel(tunnel: TunnelConfig) {
    try {
      await onStart(tunnel);
      message.success("隧道已启动");
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  function confirmDelete(tunnel: TunnelConfig) {
    modal.confirm({
      title: "删除隧道模板",
      content: tunnel.name,
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => onDelete(tunnel.id),
    });
  }

  async function copyBindAddress(forward: ForwardInfo) {
    const value = `${forward.bindHost}:${forward.bindPort}`;
    await navigator.clipboard?.writeText(value);
    message.success("监听地址已复制");
  }

  return (
    <>
      <Modal
        className="tunnelModal"
        title="SSH 隧道"
        open={open}
        onCancel={onClose}
        width={840}
        footer={null}
        destroyOnHidden
      >
        <div className="tunnelModalHeader">
          <span className="settingsSectionTitle">隧道模板</span>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ mode: "create" })}>新建</Button>
        </div>
        <Table rowKey="id" size="small" pagination={false} columns={tunnelColumns} dataSource={tunnels} />
        <h3 className="drawerSubTitle">运行中</h3>
        <Table rowKey="forwardId" size="small" pagination={false} columns={forwardColumns} dataSource={forwards} />
      </Modal>
      <TunnelConfigModal
        state={editing}
        sessions={sessions}
        onCancel={() => setEditing(null)}
        onSubmit={async (input) => {
          if (!editing) return;
          if (editing.mode === "edit") {
            await onUpdate(editing.value.id, input);
          } else {
            await onCreate(input);
          }
          setEditing(null);
        }}
      />
    </>
  );
}

function TunnelConfigModal({
  state,
  sessions,
  onCancel,
  onSubmit,
}: {
  state: TunnelModalState | null;
  sessions: RemoteSession[];
  onCancel: () => void;
  onSubmit: (input: TunnelInput) => Promise<void>;
}) {
  const [form] = Form.useForm<TunnelInput>();
  const forwardType = Form.useWatch("forwardType", form);

  useEffect(() => {
    if (!state) return;
    form.setFieldsValue(state.mode === "edit" ? state.value : {
      name: "",
      sessionId: sessions[0]?.id ?? "",
      forwardType: "local",
      bindHost: "127.0.0.1",
      bindPort: 0,
      targetHost: "127.0.0.1",
      targetPort: 22,
    });
  }, [form, sessions, state]);

  async function submit() {
    const values = await form.validateFields();
    await onSubmit({
      ...values,
      targetHost: values.forwardType === "dynamic" ? "SOCKS5" : values.targetHost,
      targetPort: values.forwardType === "dynamic" ? 0 : values.targetPort,
    });
  }

  return (
    <Modal
      open={Boolean(state)}
      className="tunnelConfigModal"
      title={null}
      footer={null}
      onCancel={onCancel}
      destroyOnHidden
      width={460}
      closable
    >
      <div className="tunnelConfigHeader">
        <div className="tunnelConfigHeaderIcon">
          <ApartmentOutlined />
        </div>
        <div className="tunnelConfigHeaderMeta">
          <span className="tunnelConfigLabel">SSH 隧道</span>
          <strong className="tunnelConfigTitle">
            {state?.mode === "edit" ? "编辑隧道" : "新建隧道"}
          </strong>
        </div>
      </div>

      <Form form={form} layout="vertical" requiredMark={false} className="tunnelConfigForm">
        <section className="tunnelConfigSection">
          <div className="tunnelConfigSectionTitle">
            <TagOutlined />
            <span>基本信息</span>
          </div>
          <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="例如：数据库隧道" />
          </Form.Item>
          <Form.Item label="关联会话" name="sessionId" rules={[{ required: true, message: "请选择会话" }]}>
            <Select
              placeholder="选择一个会话作为隧道入口"
              options={sessions.map((session) => ({ label: session.name, value: session.id }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item label="转发类型" name="forwardType" tooltip="本地转发将远端端口映射到本机；远端转发将本机端口暴露到服务器；动态 SOCKS5 把 SSH 当作代理">
            <Select
              options={[
                { label: "本地转发 (Local)", value: "local" },
                { label: "远端转发 (Remote)", value: "remote" },
                { label: "动态 SOCKS5", value: "dynamic" },
              ]}
            />
          </Form.Item>
        </section>

        <section className="tunnelConfigSection">
          <div className="tunnelConfigSectionTitle">
            <NodeIndexOutlined />
            <span>监听（本机入口）</span>
          </div>
          <div className="tunnelConfigRow">
            <Form.Item
              label="监听地址"
              name="bindHost"
              rules={[{ required: true, message: "请输入监听地址" }]}
              style={{ flex: 2 }}
            >
              <Input placeholder="127.0.0.1" />
            </Form.Item>
            <Form.Item
              label="端口"
              name="bindPort"
              rules={[{ required: true, message: "请输入监听端口" }]}
              style={{ flex: 1 }}
              tooltip="填 0 表示由系统自动分配可用端口"
            >
              <InputNumber min={0} max={65535} precision={0} style={{ width: "100%" }} placeholder="自动" />
            </Form.Item>
          </div>
        </section>

        {forwardType !== "dynamic" ? (
          <section className="tunnelConfigSection">
            <div className="tunnelConfigSectionTitle">
              <GlobalOutlined />
              <span>目标（转发去向）</span>
              <span className="tunnelConfigSectionHint">
                <SwapOutlined />
                {forwardType === "remote" ? "从服务器端访问" : "从本机访问"}
              </span>
            </div>
            <div className="tunnelConfigRow">
              <Form.Item
                label="目标地址"
                name="targetHost"
                rules={[{ required: true, message: "请输入目标地址" }]}
                style={{ flex: 2 }}
              >
                <Input placeholder="127.0.0.1 或远程主机名" />
              </Form.Item>
              <Form.Item
                label="端口"
                name="targetPort"
                rules={[{ required: true, message: "请输入目标端口" }]}
                style={{ flex: 1 }}
              >
                <InputNumber min={1} max={65535} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            </div>
          </section>
        ) : (
          <section className="tunnelConfigSection tunnelConfigSection--hint">
            <LinkOutlined />
            <span>
              动态 SOCKS5 无需填写目标，客户端可通过上方监听地址访问任意站点。
            </span>
          </section>
        )}
      </Form>

      <div className="tunnelConfigFooter">
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" onClick={() => void submit()}>
          {state?.mode === "edit" ? "保存修改" : "创建隧道"}
        </Button>
      </div>
    </Modal>
  );
}

function forwardMatchesTunnel(forward: ForwardInfo, tunnel: TunnelConfig) {
  if (forward.sessionId !== tunnel.sessionId) return false;
  if (forward.forwardType !== tunnel.forwardType) return false;
  if (forward.bindHost !== tunnel.bindHost) return false;
  if (tunnel.bindPort !== 0 && forward.bindPort !== tunnel.bindPort) return false;
  if (tunnel.forwardType === "dynamic") return true;
  return forward.targetHost === tunnel.targetHost && forward.targetPort === tunnel.targetPort;
}

function forwardTypeLabel(type: TunnelConfig["forwardType"] | ForwardInfo["forwardType"]) {
  if (type === "local") return "本地";
  if (type === "remote") return "远端";
  return "动态";
}
