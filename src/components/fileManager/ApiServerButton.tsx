import { LoadingOutlined, RobotOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";

interface ApiServerButtonProps {
  running: boolean;
  starting: boolean;
  error: string | null;
  onOpen: () => void;
}

export function ApiServerButton({ running, starting, error, onOpen }: ApiServerButtonProps) {
  const state = running ? "running" : starting ? "starting" : "stopped";
  const title = running ? "AI API 运行中" : starting ? "AI API 正在启动" : error ? `AI API 启动失败：${error}` : "AI API 已停止";

  return (
    <Tooltip title={title} placement="bottom">
      <Button
        aria-label="AI API"
        className={`fileApiButton fileApiButton-${state}`}
        icon={starting ? <LoadingOutlined /> : <RobotOutlined />}
        size="small"
        onClick={onOpen}
      />
    </Tooltip>
  );
}
