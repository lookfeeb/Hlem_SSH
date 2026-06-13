import { Alert, Button, Form, Input, Modal, Typography } from "antd";

interface MigrationGateProps {
  open: boolean;
  loading: boolean;
  error?: string;
  onMigrate: (oldPassword: string) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
}

interface FormValues {
  oldPassword: string;
}

export function MigrationGate({ open, loading, error, onMigrate, onSkip }: MigrationGateProps) {
  const [form] = Form.useForm<FormValues>();
  const oldPassword = Form.useWatch("oldPassword", form) ?? "";
  const canSubmit = oldPassword.trim().length >= 6;

  async function submit(values: FormValues) {
    await onMigrate(values.oldPassword);
  }

  return (
    <Modal
      open={open}
      footer={null}
      closable={false}
      mask={{ closable: false }}
      centered
      width={420}
      styles={{
        mask: { backdropFilter: "blur(8px)", background: "rgba(244, 247, 250, 0.7)" },
        container: {
          padding: 0,
          borderRadius: 16,
          overflow: "hidden",
          background: "var(--bg-surface)",
          boxShadow: "var(--shadow-lg)",
        },
        body: { padding: 0 },
      }}
    >
      <div style={{ padding: "32px 28px", textAlign: "center" }}>
        <div style={{ marginBottom: 16 }}>
          <img src="./Helm_icon.svg" alt="" aria-hidden="true" style={{ width: 48, height: 48 }} />
        </div>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>数据迁移</h1>
        <p style={{ color: "var(--text-secondary)", marginBottom: 20, fontSize: 13 }}>
          检测到旧版本加密数据，请输入之前设置的主密码以完成一次性迁移。
          迁移后将不再需要密码。
        </p>

        {error && (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
        )}

        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            label="旧主密码"
            name="oldPassword"
            rules={[
              { required: true, message: "请输入旧主密码" },
              { min: 6, message: "主密码至少 6 位" },
            ]}
          >
            <Input.Password
              autoFocus
              placeholder="输入之前设置的主密码"
              size="large"
              onPressEnter={() => {
                if (canSubmit) form.submit();
              }}
            />
          </Form.Item>

          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            disabled={!canSubmit}
            block
            size="large"
          >
            迁移数据
          </Button>
        </Form>

        <Typography.Text
          type="secondary"
          style={{ display: "block", textAlign: "center", marginTop: 16, cursor: "pointer" }}
          onClick={() => void onSkip()}
        >
          忘记密码？跳过迁移（旧数据将丢失）
        </Typography.Text>
      </div>
    </Modal>
  );
}
