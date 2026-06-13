import {
  DeleteOutlined,
  DesktopOutlined,
  DisconnectOutlined,
  DownOutlined,
  EditOutlined,
  LoginOutlined,
  LoadingOutlined,
  PlusOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import { Button, Input, Modal, Tooltip } from "antd";
import { useMemo, useState } from "react";
import type { ConnectionState, RemoteSession, SessionGroup } from "../types";

interface ConnectionSidebarProps {
  sessions: RemoteSession[];
  groups: SessionGroup[];
  activeSessionId: string;
  connectingSessionId: string | null;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onConnect: (session: RemoteSession) => void;
  onDisconnect: (session: RemoteSession) => void;
  onCancelConnect: (id: string) => void;
  onFavoriteChange: (sessionId: string, favorite: boolean) => void;
  onMarkRecent: (sessionId: string) => void;
}

type SessionSection = {
  id: string;
  name: string;
  sessions: RemoteSession[];
};

const MAX_RECENT_SESSIONS = 5;

export function ConnectionSidebar({
  sessions,
  groups,
  activeSessionId,
  connectingSessionId,
  onActivate,
  onAdd,
  onEdit,
  onDelete,
  onConnect,
  onDisconnect,
  onCancelConnect,
  onFavoriteChange,
  onMarkRecent,
}: ConnectionSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(new Set());
  const query = searchQuery.trim().toLowerCase();

  const sections = useMemo<SessionSection[]>(() => {
    const matchedSessions = query
      ? sessions.filter((session) =>
          [session.name, session.host, session.username].some((value) => value.toLowerCase().includes(query)),
        )
      : sessions;

    const sortSessionList = (items: RemoteSession[]) => sortSessionsByPreference(items);

    if (query) {
      return [{ id: "search", name: "搜索结果", sessions: sortSessionList(matchedSessions) }];
    }

    const favoriteSessions = sortSessionList(matchedSessions.filter((session) => session.favorite));
    const recentSessions = sortSessionsByRecent(matchedSessions.filter((session) => session.lastConnectedAt)).slice(0, MAX_RECENT_SESSIONS);
    const prioritySections: SessionSection[] = [
      ...(favoriteSessions.length > 0 ? [{ id: "favorites", name: "收藏连接", sessions: favoriteSessions }] : []),
      ...(recentSessions.length > 0 ? [{ id: "recent", name: "最近连接", sessions: recentSessions }] : []),
    ];

    if (groups.length === 0) {
      return [...prioritySections, { id: "all", name: "我的主机", sessions: sortSessionList(matchedSessions) }];
    }

    const groupIds = new Set(groups.map((group) => group.id));
    const grouped = [...groups]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((group) => ({
        id: group.id,
        name: group.name || "未命名分组",
        sessions: sortSessionList(matchedSessions.filter((session) => session.groupId === group.id)),
      }))
      .filter((section) => section.sessions.length > 0);

    const ungrouped = sortSessionList(matchedSessions.filter((session) => !session.groupId || !groupIds.has(session.groupId)));
    if (ungrouped.length > 0) {
      grouped.unshift({ id: "ungrouped", name: "我的主机", sessions: ungrouped });
    }

    return grouped.length > 0 ? [...prioritySections, ...grouped] : [...prioritySections, { id: "all", name: "我的主机", sessions: [] }];
  }, [groups, query, sessions]);

  function toggleSection(sectionId: string) {
    setCollapsedSectionIds((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }

  function openSession(session: RemoteSession) {
    const state = sessionState(session, connectingSessionId);
    onActivate(session.id);
    if (state === "connected" || state === "connecting") {
      onMarkRecent(session.id);
      return;
    }
    onConnect(session);
  }

  function toggleFavorite(session: RemoteSession) {
    onFavoriteChange(session.id, !session.favorite);
  }

  function confirmDelete(session: RemoteSession) {
    Modal.confirm({
      title: "删除连接",
      content: `确定删除「${session.name}」吗？此操作不可撤销。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => onDelete(session.id),
    });
  }

  return (
    <aside className="connectionSidebar">
      <div className="connectionSidebarHeader">
        <div className="connectionSidebarHeaderMain">
          <strong>连接管理</strong>
          <Input
            className="connectionSearchInput"
            placeholder="搜索主机或用户名"
            prefix={<SearchOutlined />}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            allowClear
          />
        </div>
        <Tooltip title="新建连接" placement="right">
          <Button aria-label="新建连接" icon={<PlusOutlined />} size="small" onClick={onAdd} />
        </Tooltip>
      </div>

      <div className="connectionSectionList">
        {sections.map((section) => {
          const collapsed = collapsedSectionIds.has(section.id);
          return (
            <section className="connectionSection" key={section.id}>
              <button
                type="button"
                className="connectionSectionHeader"
                onClick={() => toggleSection(section.id)}
              >
                <span className={collapsed ? "connectionSectionChevron connectionSectionChevron-collapsed" : "connectionSectionChevron"}>
                  <DownOutlined />
                </span>
                <span>{section.name}</span>
                <em>{section.sessions.length}</em>
              </button>

              {!collapsed && (
                <div className="connectionList">
                  {section.sessions.length === 0 ? (
                    <div className="connectionEmpty">暂无连接</div>
                  ) : (
                    section.sessions.map((session) => {
                      const state = sessionState(session, connectingSessionId);
                      const connected = state === "connected";
                      const connecting = state === "connecting";
                      const active = session.id === activeSessionId;
                      const favorite = session.favorite;

                      return (
                        <div
                          key={session.id}
                          className={`connectionItem connectionItem-${state}${active ? " connectionItem-active" : ""}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => openSession(session)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            openSession(session);
                          }}
                        >
                          <div className="sessionCardIconWrapper">
                            <DesktopOutlined />
                            <span className={`sessionCardStateDot sessionCardStateDot-${state}`} />
                          </div>
                          <span className="connectionItemText">
                            <strong title={session.name}>{session.name}</strong>
                            <span title={`${session.username}@${session.host}`}>
                              {session.username}@{session.host}
                            </span>
                          </span>
                          <span className="connectionItemActions">
                            <Tooltip title={favorite ? "取消收藏" : "收藏"}>
                              <Button
                                aria-label={favorite ? `取消收藏 ${session.name}` : `收藏 ${session.name}`}
                                className={favorite ? "connectionFavoriteButton connectionFavoriteButton-active" : "connectionFavoriteButton"}
                                icon={favorite ? <StarFilled /> : <StarOutlined />}
                                size="small"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleFavorite(session);
                                }}
                              />
                            </Tooltip>
                            <Tooltip title={connected ? "断开" : connecting ? "取消连接" : "连接"}>
                              <Button
                                aria-label={connected ? `断开 ${session.name}` : connecting ? `取消连接 ${session.name}` : `连接 ${session.name}`}
                                icon={connected ? <DisconnectOutlined /> : connecting ? <LoadingOutlined /> : <LoginOutlined />}
                                size="small"
                                danger={connected || connecting}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (connected) {
                                    onDisconnect(session);
                                  } else if (connecting) {
                                    onCancelConnect(session.id);
                                  } else {
                                    openSession(session);
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
                                  confirmDelete(session);
                                }}
                              />
                            </Tooltip>
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function sessionState(session: RemoteSession, connectingSessionId: string | null): ConnectionState {
  return connectingSessionId === session.id ? "connecting" : session.state;
}

function sortSessionsByPreference(sessions: RemoteSession[]) {
  return [...sessions].sort((a, b) => {
    const favoriteRankA = a.favorite ? 0 : 1;
    const favoriteRankB = b.favorite ? 0 : 1;
    if (favoriteRankA !== favoriteRankB) return favoriteRankA - favoriteRankB;

    const recentTimeA = parseSessionTime(a.lastConnectedAt);
    const recentTimeB = parseSessionTime(b.lastConnectedAt);
    if (recentTimeA !== recentTimeB) return recentTimeB - recentTimeA;

    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

function sortSessionsByRecent(sessions: RemoteSession[]) {
  return [...sessions].sort((a, b) => {
    const recentTimeA = parseSessionTime(a.lastConnectedAt);
    const recentTimeB = parseSessionTime(b.lastConnectedAt);
    if (recentTimeA !== recentTimeB) return recentTimeB - recentTimeA;

    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

function parseSessionTime(value?: string | null) {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
