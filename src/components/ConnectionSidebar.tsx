import {
  DeleteOutlined,
  DesktopOutlined,
  DisconnectOutlined,
  DownOutlined,
  EditOutlined,
  LoginOutlined,
  LoadingOutlined,
  PlusOutlined,
  PlusSquareOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import { Button, Input, Modal, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeCollapsedConnectionSectionIds,
  shouldPersistConnectionSectionId,
  toggleCollapsedConnectionSectionId,
} from "../app/connectionSectionState";
import { sortConnectionsByCount, sortConnectionsByCreatedAt } from "../app/connectionOrdering";
import type { ConnectionState, RemoteSession, SessionGroup } from "../types";

interface ConnectionSidebarProps {
  sessions: RemoteSession[];
  groups: SessionGroup[];
  activeSessionId: string;
  connectingSessionIds: ReadonlySet<string>;
  onActivate: (session: RemoteSession) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onConnect: (session: RemoteSession) => void;
  onDisconnect: (session: RemoteSession) => void;
  onCancelConnect: (id: string) => void;
  onFavoriteChange: (sessionId: string, favorite: boolean) => void;
  onClearRecent: (sessionId: string) => void;
  collapsedSectionIds: string[];
  onCollapsedSectionIdsChange: (sectionIds: string[]) => Promise<void>;
}

type SessionSection = {
  id: string;
  name: string;
  sessions: RemoteSession[];
};

const MAX_RECENT_SESSIONS = 10;

export function ConnectionSidebar({
  sessions,
  groups,
  activeSessionId,
  connectingSessionIds,
  onActivate,
  onAdd,
  onEdit,
  onDelete,
  onConnect,
  onDisconnect,
  onCancelConnect,
  onFavoriteChange,
  onClearRecent,
  collapsedSectionIds,
  onCollapsedSectionIdsChange,
}: ConnectionSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedCollapsedSectionIds = normalizeCollapsedConnectionSectionIds(collapsedSectionIds);
  const persistedCollapsedKey = normalizedCollapsedSectionIds.join("\u0000");
  const [localCollapsedSectionIds, setLocalCollapsedSectionIds] = useState<Set<string>>(
    () => new Set(normalizedCollapsedSectionIds),
  );
  const collapseChangeVersionRef = useRef(0);
  const query = searchQuery.trim().toLowerCase();

  useEffect(() => {
    setLocalCollapsedSectionIds(new Set(normalizedCollapsedSectionIds));
  }, [persistedCollapsedKey]);

  const sections = useMemo<SessionSection[]>(() => {
    const matchedSessions = query
      ? sessions.filter((session) =>
          [session.name, session.host, session.username].some((value) => value.toLowerCase().includes(query)),
        )
      : sessions;

    const sortSessionList = (items: RemoteSession[]) => sortConnectionsByCreatedAt(items);

    if (query) {
      return [{ id: "search", name: "搜索结果", sessions: sortSessionList(matchedSessions) }];
    }

    const favoriteSessions = sortSessionList(matchedSessions.filter((session) => session.favorite));
    const recentSessions = sortConnectionsByCount(
      matchedSessions.filter((session) => session.lastConnectedAt),
    ).slice(0, MAX_RECENT_SESSIONS);
    const prioritySections: SessionSection[] = [
      ...(favoriteSessions.length > 0 ? [{ id: "favorites", name: "收藏连接", sessions: favoriteSessions }] : []),
      ...(recentSessions.length > 0 ? [{ id: "recent", name: "最近连接", sessions: recentSessions }] : []),
    ];

    if (groups.length === 0) {
      return [...prioritySections, { id: "all", name: "我的主机", sessions: sortSessionList(matchedSessions) }];
    }

    const groupIds = new Set(groups.map((group) => group.id));
    const sessionsByGroup = new Map<string, RemoteSession[]>();
    const ungroupedSessions: RemoteSession[] = [];
    for (const session of matchedSessions) {
      if (session.groupId && groupIds.has(session.groupId)) {
        const groupedSessions = sessionsByGroup.get(session.groupId) ?? [];
        groupedSessions.push(session);
        sessionsByGroup.set(session.groupId, groupedSessions);
      } else {
        ungroupedSessions.push(session);
      }
    }
    const grouped = sortConnectionsByCreatedAt(groups)
      .map((group) => ({
        id: group.id,
        name: group.name || "未命名分组",
        sessions: sortSessionList(sessionsByGroup.get(group.id) ?? []),
      }))
      .filter((section) => section.sessions.length > 0);

    const ungrouped = sortSessionList(ungroupedSessions);
    if (ungrouped.length > 0) {
      grouped.unshift({ id: "ungrouped", name: "我的主机", sessions: ungrouped });
    }

    return grouped.length > 0 ? [...prioritySections, ...grouped] : [...prioritySections, { id: "all", name: "我的主机", sessions: [] }];
  }, [groups, query, sessions]);

  function toggleSection(sectionId: string) {
    const nextIds = toggleCollapsedConnectionSectionId(localCollapsedSectionIds, sectionId);
    setLocalCollapsedSectionIds(new Set(nextIds));
    if (!shouldPersistConnectionSectionId(sectionId)) return;
    const version = collapseChangeVersionRef.current + 1;
    collapseChangeVersionRef.current = version;
    void onCollapsedSectionIdsChange(nextIds).catch(() => {
      if (collapseChangeVersionRef.current !== version) return;
      setLocalCollapsedSectionIds(new Set(normalizedCollapsedSectionIds));
    });
  }

  function openSession(session: RemoteSession) {
    const state = sessionState(session, connectingSessionIds);
    if (state === "connecting") {
      return;
    }
    if (state === "connected") {
      onActivate(session);
    } else {
      onConnect(session);
    }
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

  function confirmClearRecent(session: RemoteSession) {
    Modal.confirm({
      title: "移除最近连接",
      content: `确定将「${session.name}」从最近连接中移除吗？`,
      okText: "移除",
      cancelText: "取消",
      onOk: () => onClearRecent(session.id),
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
          const collapsed = localCollapsedSectionIds.has(section.id);
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
                      const state = sessionState(session, connectingSessionIds);
                      const connected = state === "connected";
                      const connecting = state === "connecting";
                      const active = session.id === activeSessionId;
                      const favorite = session.favorite;
                      const recentSection = section.id === "recent";

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
                            {connected && (
                              <Tooltip title="新开终端">
                                <Button
                                  aria-label={`新开终端 ${session.name}`}
                                  icon={<PlusSquareOutlined />}
                                  size="small"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onConnect(session);
                                  }}
                                />
                              </Tooltip>
                            )}
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
                            <Tooltip title={recentSection ? "从最近连接移除" : "删除"}>
                              <Button
                                aria-label={recentSection ? `从最近连接移除 ${session.name}` : `删除 ${session.name}`}
                                icon={<DeleteOutlined />}
                                size="small"
                                danger={!recentSection}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (recentSection) {
                                    confirmClearRecent(session);
                                  } else {
                                    confirmDelete(session);
                                  }
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

function sessionState(session: RemoteSession, connectingSessionIds: ReadonlySet<string>): ConnectionState {
  return connectingSessionIds.has(session.id) ? "connecting" : session.state;
}
