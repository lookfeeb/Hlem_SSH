import {
  ApiOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  LoadingOutlined,
  LockOutlined,
  PlusOutlined,
  SearchOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import { Button, Input, Tooltip } from "antd";
import type { ConnectionState, RemoteSession, SessionGroup } from "../types";

interface SessionListModalInnerProps {
  sessions: RemoteSession[];
  groups: SessionGroup[];
  activeSessionId: string;
  connectingSessionId: string | null;
  sessionListGroupId: string;
  setSessionListGroupId: (id: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  openCreateSession: () => void;
  openSessionFromList: (session: RemoteSession) => void;
  onDisconnect: (session: RemoteSession) => void;
  onCancelConnect: (id: string) => void;
  onEdit: (id: string) => void;
  onDeleteConfirm: (confirm: { id: string; name: string } | null) => void;
  filteredSessions: RemoteSession[];
}

export function SessionListModalInner({
  sessions,
  groups,
  activeSessionId,
  connectingSessionId,
  sessionListGroupId,
  setSessionListGroupId,
  searchQuery,
  setSearchQuery,
  openCreateSession,
  openSessionFromList,
  onDisconnect,
  onCancelConnect,
  onEdit,
  onDeleteConfirm,
  filteredSessions,
}: SessionListModalInnerProps) {
  function sessionState(session: RemoteSession, connectingId: string | null): ConnectionState {
    return connectingId === session.id ? "connecting" : session.state;
  }

  return (
    <div className="sessionListModalContainer">
      {/* 左侧侧边栏 */}
      <div className="sessionListModalSidebar">
        <div className="sidebarTitle">会话分组</div>
        <div className="groupNavList">
          {/* 全部会话 */}
          <div
            className={`groupNavItem${sessionListGroupId === "all" ? " groupNavItem-active" : ""}`}
            onClick={() => setSessionListGroupId("all")}
          >
            <span className="groupNavItemName">
              <FolderOpenOutlined style={{ color: "var(--accent-2)" }} />
              全部会话
            </span>
            <span className="groupNavItemCount">{sessions.length}</span>
          </div>

          {/* 自定义分组 */}
          {groups.map((group) => {
            const defaultGroup = group.sortOrder === 0;
            const count = sessions.filter((s) => s.groupId === group.id).length;
            const active = sessionListGroupId === group.id;
            return (
              <div
                key={group.id}
                className={`groupNavItem${active ? " groupNavItem-active" : ""}`}
                onClick={() => setSessionListGroupId(group.id)}
              >
                <span className="groupNavItemName">
                  {defaultGroup ? (
                    <LockOutlined style={{ color: "var(--text-muted)" }} />
                  ) : (
                    <FolderOutlined style={{ color: "var(--accent)" }} />
                  )}
                  {group.name}
                </span>
                <span className="groupNavItemCount">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 右侧会话列表 */}
      <div className="sessionListModalContent">
        <div className="contentHeader">
          <div className="contentHeaderTitle">
            <h3>SSH 会话</h3>
            <span>共计 {filteredSessions.length} 个连接</span>
          </div>
          <div className="contentActions">
            <Input
              placeholder="搜索名称/主机/用户名..."
              className="sessionSearchInput"
              prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              allowClear
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              className="contentAddBtn"
              onClick={openCreateSession}
            >
              新建连接
            </Button>
          </div>
        </div>

        <div className="sessionListScrollContainer">
          {filteredSessions.length === 0 && (
            <div className="sessionListEmpty">
              {sessions.length === 0 ? "暂无 SSH 连接" : "未找到匹配的连接"}
            </div>
          )}
          {filteredSessions.map((session) => {
            const active = session.id === activeSessionId;
            const state = sessionState(session, connectingSessionId);
            const connected = state === "connected";
            const connecting = connectingSessionId === session.id;

            return (
              <div
                key={session.id}
                className={`sessionCard${active ? " sessionCard-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => openSessionFromList(session)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openSessionFromList(session);
                  }
                }}
              >
                <div className="sessionCardIconWrapper">
                  <DesktopOutlined />
                  <span className={`sessionCardStateDot sessionCardStateDot-${state}`} />
                </div>

                <div className="sessionCardText">
                  <strong className="sessionCardName">{session.name}</strong>
                  <span className="sessionCardMeta">
                    {session.username}@{session.host}
                  </span>
                </div>

                <div className="sessionCardActions">
                  <Tooltip title={connected ? "断开连接" : connecting ? "取消连接" : "连接"}>
                    <Button
                      aria-label={
                        connected
                          ? `断开 ${session.name}`
                          : connecting
                          ? `取消连接 ${session.name}`
                          : `连接 ${session.name}`
                      }
                      icon={
                        connected ? (
                          <DisconnectOutlined />
                        ) : connecting ? (
                          <LoadingOutlined />
                        ) : (
                          <ApiOutlined />
                        )
                      }
                      size="small"
                      danger={connected || connecting}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (connected) {
                          onDisconnect(session);
                        } else if (connecting) {
                          onCancelConnect(session.id);
                        } else {
                          openSessionFromList(session);
                        }
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="编辑">
                    <Button
                      aria-label={`编辑 ${session.name}`}
                      icon={<EditOutlined />}
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEdit(session.id);
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="删除">
                    <Button
                      aria-label={`删除 ${session.name}`}
                      icon={<DeleteOutlined />}
                      size="small"
                      danger
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteConfirm({ id: session.id, name: session.name });
                      }}
                    />
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
