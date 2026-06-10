import {
  ApiOutlined,
  AppstoreOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  LoadingOutlined,
  PlusOutlined,
  ProfileOutlined,
  RobotOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { Badge, Button, Modal, Space, Tabs, Tooltip } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ConnectionState, RemoteSession, SessionGroup, TransferInfo } from "../types";
import { SessionListModalInner } from "./SessionListModalInner";

const SESSION_LIST_MODAL_Z_INDEX = 1000;
const DELETE_CONFIRM_MODAL_Z_INDEX = 1100;

interface TopBarProps {
  sessions: RemoteSession[];
  groups: SessionGroup[];
  tabSessions: RemoteSession[];
  activeSessionId: string;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onConnect: (session: RemoteSession) => void;
  onDisconnect: (session: RemoteSession) => void;
  onCancelConnect: (id: string) => void;
  onTransferOpen: () => void;
  onSettingsOpen: () => void;
  connectingSessionId: string | null;
  transfers: TransferInfo[];
  sessionListOpen: boolean;
  onSessionListOpenChange: (open: boolean) => void;
  apiServerRunning: boolean;
  apiConfigured: boolean;
  onApiServerStart: () => void;
}

export function TopBar({
  sessions,
  groups,
  tabSessions,
  activeSessionId,
  onActivate,
  onAdd,
  onClose,
  onEdit,
  onDelete,
  onConnect,
  onDisconnect,
  onCancelConnect,
  onTransferOpen,
  onSettingsOpen,
  connectingSessionId,
  transfers,
  sessionListOpen,
  onSessionListOpenChange,
  apiServerRunning,
  apiConfigured,
  onApiServerStart,
}: TopBarProps) {

  const [sessionListGroupId, setSessionListGroupId] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const activeSessionListGroupId = sessionListGroupId || "all";

  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      return sessions.filter(
        (session) =>
          session.name.toLowerCase().includes(q) ||
          session.host.toLowerCase().includes(q) ||
          session.username.toLowerCase().includes(q),
      );
    }

    if (activeSessionListGroupId !== "all") {
      return sessions.filter((session) => session.groupId === activeSessionListGroupId);
    }

    return sessions;
  }, [sessions, activeSessionListGroupId, searchQuery]);

  const activeTransferTotal = activeTransferCount(transfers);



  useEffect(() => {
    if (!groups.length) {
      if (sessionListGroupId) setSessionListGroupId("");
      return;
    }
    if (sessionListGroupId === "all") return;
    if (!sessionListGroupId || !groups.some((group) => group.id === sessionListGroupId)) {
      setSessionListGroupId("all");
    }
  }, [groups, sessionListGroupId]);



  function openCreateSession() {
    onAdd();
  }

  function openSessionFromList(session: RemoteSession) {
    onActivate(session.id);
    onSessionListOpenChange(false);
    if (connectingSessionId === session.id || session.state === "connected") return;
    onConnect(session);
  }

  return (
    <header className="topBar">
      <div className="brand">
        <span className="brandMark">
          <img className="brandIcon" src="./nexus_icon.svg" alt="" aria-hidden="true" />
          <span>HelM</span>
        </span>
        <span className="brandActions">
          {apiConfigured && (
            <Tooltip title={apiServerRunning ? "AI API 运行中" : "AI API 已停止"} placement="bottom">
              <Button
                aria-label="AI API"
                className={`brandApiButton${apiServerRunning ? " brandApiButton-running" : " brandApiButton-stopped"}`}
                icon={<RobotOutlined />}
                size="small"
                onClick={onApiServerStart}
              />
            </Tooltip>
          )}
          <Tooltip title="设置" placement="bottom">
            <Button
              aria-label="设置"
              icon={<SettingOutlined />}
              size="small"
              onClick={onSettingsOpen}
            />
          </Tooltip>
        </span>
      </div>
      <Tabs
        className="sessionTabs"
        hideAdd
        tabBarExtraContent={{
          right: (
            <Tooltip title="会话列表" placement="bottom">
              <Button
                aria-label="会话列表"
                className="sessionTabsListButton"
                icon={<AppstoreOutlined />}
                size="small"
                onClick={() => onSessionListOpenChange(true)}
              />
            </Tooltip>
          ),
        }}
        type="editable-card"
        size="small"
        activeKey={activeSessionId}
        onChange={onActivate}
        onTabClick={(key) => {
          if (key === activeSessionId) {
            const session = tabSessions.find((s) => s.id === key);
            if (!session) return;
            const state = sessionState(session, connectingSessionId);
            if (state === "connected") {
              onDisconnect(session);
            } else if (state === "connecting") {
              onCancelConnect(session.id);
            } else if (state === "disconnected" || state === "failed") {
              onConnect(session);
            }
          }
        }}
        onEdit={(targetKey, action) => {
          if (action === "add") onAdd();
          if (action === "remove" && typeof targetKey === "string")
            onClose(targetKey);
        }}
        items={tabSessions.map((session) => {
          const state = sessionState(session, connectingSessionId);
          return {
            key: session.id,
            label: (
              <span className={`sessionTabLabel sessionTabLabel-${state}`}>
                <span className="sessionTabName">{session.name}</span>
              </span>
            ),
            closable: true,
          };
        })}
      />

      <Space size={4} className="toolbar">
        <Tooltip title={activeTransferTotal > 0 ? `传输进行中 · ${activeTransferTotal} 条` : "传输列表"} placement="bottom">
          <Badge size="small" count={activeTransferTotal} offset={[-2, 2]}>
            <Button
              aria-label="传输列表"
              className={activeTransferTotal > 0 ? "transferToolbarButton transferToolbarButton-active" : "transferToolbarButton"}
              icon={<ProfileOutlined />}
              size="small"
              onClick={onTransferOpen}
            />
          </Badge>
        </Tooltip>
      </Space>

      <Modal
        title={null}
        open={sessionListOpen}
        footer={null}
        centered
        width={780}
        className="sessionListModal"
        zIndex={SESSION_LIST_MODAL_Z_INDEX}
        transitionName=""
        maskTransitionName=""
        destroyOnHidden
        onCancel={() => onSessionListOpenChange(false)}
      >
        <SessionListModalInner
          sessions={sessions}
          groups={groups}
          activeSessionId={activeSessionId}
          connectingSessionId={connectingSessionId}
          sessionListGroupId={sessionListGroupId}
          setSessionListGroupId={setSessionListGroupId}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          openCreateSession={openCreateSession}
          openSessionFromList={openSessionFromList}
          onDisconnect={onDisconnect}
          onCancelConnect={onCancelConnect}
          onEdit={onEdit}
          onDeleteConfirm={setDeleteConfirm}
          filteredSessions={filteredSessions}
        />
      </Modal>
      <Modal
        open={!!deleteConfirm}
        title={null}
        footer={null}
        closable={false}
        centered
        width={360}
        className="deleteConfirmModal"
        zIndex={DELETE_CONFIRM_MODAL_Z_INDEX}
        onCancel={() => setDeleteConfirm(null)}
      >
        <div className="deleteConfirmContent">
          <div className="deleteConfirmIcon">
            <DeleteOutlined />
          </div>
          <h3 className="deleteConfirmTitle">确认删除</h3>
          <p className="deleteConfirmDesc">
            确定要删除会话「<strong>{deleteConfirm?.name}</strong>」吗？此操作不可撤销。
          </p>
          <div className="deleteConfirmActions">
            <Button onClick={() => setDeleteConfirm(null)}>取消</Button>
            <Button
              danger
              type="primary"
              onClick={() => {
                if (deleteConfirm) {
                  onDelete(deleteConfirm.id);
                  setDeleteConfirm(null);
                }
              }}
            >
              删除
            </Button>
          </div>
        </div>
      </Modal>
    </header>
  );
}

function sessionState(session: RemoteSession, connectingSessionId: string | null): ConnectionState {
  return connectingSessionId === session.id ? "connecting" : session.state;
}

function activeTransferCount(transfers: TransferInfo[]) {
  return transfers.filter((transfer) => transfer.status === "queued" || transfer.status === "running" || transfer.status === "paused").length;
}
