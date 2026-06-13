import { PlusOutlined } from "@ant-design/icons";
import { Button } from "antd";

type EmptyWorkspaceProps = {
  sessionCount: number;
  onAddSession: () => void;
};

export function EmptyWorkspace({ sessionCount, onAddSession }: EmptyWorkspaceProps) {
  const hasSessions = sessionCount > 0;

  return (
    <section className="emptyWorkspace">
      <div className="emptyWorkbench">
        {hasSessions ? (
          <>
            <h2>请选择会话</h2>
            <p>已保存 {sessionCount} 个 SSH 连接，请从左侧连接管理中选择并连接。</p>
            <div className="emptyWorkbenchActions">
              <Button type="primary" icon={<PlusOutlined />} onClick={onAddSession}>
                新建会话
              </Button>
            </div>
          </>
        ) : (
          <>
            <h2>暂无会话</h2>
            <p>新建一个 SSH 会话开始使用。</p>
            <Button type="primary" icon={<PlusOutlined />} onClick={onAddSession}>
              新建会话
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
