import { DisconnectOutlined, GlobalOutlined, LinkOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Form, Input, InputNumber, Select, Switch } from "antd";

interface SettingsFormValues {
  enabled: boolean;
  kind: "socks5" | "httpConnect";
  host: string;
  port: number;
}

interface ProxyFormProps {
  form: ReturnType<typeof Form.useForm<SettingsFormValues>>[0];
  enabled: boolean;
}

export function ProxyForm({ form, enabled }: ProxyFormProps) {
  const kind = Form.useWatch("kind", form) ?? "socks5";
  const host = Form.useWatch("host", form) ?? "127.0.0.1";
  const port = Form.useWatch("port", form) ?? 1080;
  const kindLabel = kind === "httpConnect" ? "HTTP CONNECT" : "SOCKS5";

  return (
    <section className={`settingsWorkspacePanel settingsProxyPanel ${enabled ? "is-enabled" : ""}`}>
      <div className="settingsPanelHeader settingsProxyHeader">
        <span className="settingsPanelIcon is-proxy" aria-hidden="true"><GlobalOutlined /></span>
        <div className="settingsPanelHeading">
          <strong>应用内全局代理</strong>
          <span>为 HelM 内部发起的新连接指定统一网络路径</span>
        </div>
        <div className={`settingsProxyToggle ${enabled ? "is-enabled" : ""}`}>
          <span><strong>{enabled ? "已启用" : "未启用"}</strong><small>{enabled ? "新连接走代理" : "保持直接连接"}</small></span>
          <Form form={form} component={false}>
            <Form.Item name="enabled" valuePropName="checked" noStyle>
              <Switch aria-label="启用应用内全局代理" />
            </Form.Item>
          </Form>
        </div>
      </div>

      <div className={`settingsProxyRuntime ${enabled ? "is-enabled" : ""}`} aria-live="polite">
        <span className="settingsProxyRuntimeIcon" aria-hidden="true">{enabled ? <LinkOutlined /> : <DisconnectOutlined />}</span>
        <div>
          <strong>{enabled ? "代理路径已配置" : "当前保持直接连接"}</strong>
          <small>{enabled ? `${kindLabel} · ${host || "未填写主机"}:${port || "未填写端口"}` : "开启后，下方代理参数才会应用于新连接。"}</small>
        </div>
      </div>

      <Form form={form} layout="vertical" requiredMark={false} className="settingsProxyForm">
        <Form.Item label="代理类型" name="kind">
          <Select
            disabled={!enabled}
            options={[
              { label: "SOCKS5", value: "socks5" },
              { label: "HTTP CONNECT", value: "httpConnect" },
            ]}
          />
        </Form.Item>
        <Form.Item label="代理主机" name="host" rules={enabled ? [{ required: true, message: "请输入代理主机" }] : []}>
          <Input disabled={!enabled} placeholder="127.0.0.1" />
        </Form.Item>
        <Form.Item label="代理端口" name="port" rules={enabled ? [{ required: true, message: "请输入代理端口" }] : []}>
          <InputNumber disabled={!enabled} min={1} max={65535} precision={0} style={{ width: "100%" }} />
        </Form.Item>
      </Form>

      <div className="settingsProxyNote">
        <SafetyCertificateOutlined />
        <span>仅影响 HelM 内部连接，不会修改 Windows 系统代理设置。</span>
      </div>
    </section>
  );
}
