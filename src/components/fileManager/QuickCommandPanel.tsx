import { Button, Dropdown, Popover, Space, Tooltip, type MenuProps } from "antd";
import {
  CloseOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  PlayCircleFilled,
  PlusOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { getErrorMessage } from "../../lib/configMapping";
import type { QuickCommand } from "../../types";

export interface QuickCommandTopAreaProps {
  children: ReactNode;
  leading?: ReactNode;
  dockId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuickCommandTopArea({ children, leading, dockId, open, onOpenChange }: QuickCommandTopAreaProps) {
  return (
    <div className="fileTopArea">
      <div className="fileToolbar">
        <Space className="fileToolbarActions" size={4}>
          {leading}
          <Tooltip title={open ? "关闭常用命令" : "常用命令"}>
            <Button
              aria-controls={dockId}
              aria-expanded={open}
              aria-label={open ? "关闭常用命令" : "常用命令"}
              className={`fileCommandDropdownButton${open ? " fileCommandDropdownButton-active" : ""}`}
              icon={<CodeOutlined />}
              size="small"
              onClick={() => onOpenChange(!open)}
            />
          </Tooltip>
          {children}
        </Space>
      </div>
    </div>
  );
}

export interface QuickCommandDockProps {
  id: string;
  commandItems: QuickCommand[];
  onSendCommand: (command: QuickCommand) => void | Promise<void>;
  onEditCommand: (command?: QuickCommand) => void;
  onDeleteCommand: (command: QuickCommand) => void;
}

export function QuickCommandDock({ id, commandItems, onSendCommand, onEditCommand, onDeleteCommand }: QuickCommandDockProps) {
  const [searchText, setSearchText] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);

  const visibleCommands = useMemo(() => {
    const keyword = searchText.trim().toLocaleLowerCase();
    return keyword
      ? commandItems.filter((item) => `${item.name}\n${item.command}`.toLocaleLowerCase().includes(keyword))
      : commandItems;
  }, [commandItems, searchText]);

  function runCommand(command: QuickCommand) {
    void Promise.resolve(onSendCommand(command)).catch((error) => {
      console.warn("[helm] failed to send quick command:", getErrorMessage(error));
    });
  }

  function commandMenu(command: QuickCommand): MenuProps {
    return {
      items: [
        {
          key: "edit",
          icon: <EditOutlined />,
          label: "编辑命令",
        },
        {
          type: "divider",
        },
        {
          key: "delete",
          danger: true,
          icon: <DeleteOutlined />,
          label: "删除命令",
        },
      ],
      onClick: ({ key }) => {
        if (key === "edit") onEditCommand(command);
        if (key === "delete") onDeleteCommand(command);
      },
    };
  }

  return (
    <aside id={id} className="quickCommandDock" aria-label="常用命令停靠栏">
      <div className="quickCommandDockHeader">
        <div className="quickCommandDockIdentity">
          <span className="quickCommandDockIcon" aria-hidden="true">&gt;_</span>
          <span className="quickCommandDockCopy">
            <strong>常用命令</strong>
            <small>运行后发送到当前终端</small>
          </span>
        </div>
        <div className="quickCommandDockControls">
          <Popover
            trigger="click"
            placement="bottomRight"
            open={searchOpen}
            onOpenChange={setSearchOpen}
            afterOpenChange={(open) => {
              if (open) searchInputRef.current?.focus();
            }}
            content={(
              <div
                id={`${id}-search`}
                className="quickCommandSearch"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setSearchOpen(false);
                    searchButtonRef.current?.focus();
                  }
                }}
              >
                <SearchOutlined />
                <input
                  ref={searchInputRef}
                  aria-label="搜索常用命令"
                  placeholder="搜索命令名称或内容…"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                />
                {searchText ? (
                  <button type="button" aria-label="清除搜索" title="清除搜索" onClick={() => {
                    setSearchText("");
                    searchInputRef.current?.focus();
                  }}>
                    <CloseOutlined />
                  </button>
                ) : null}
              </div>
            )}
          >
            <button
              ref={searchButtonRef}
              type="button"
              className={`quickCommandSearchButton${searchOpen || searchText.trim() ? " quickCommandSearchButton-active" : ""}`}
              aria-label="搜索常用命令"
              aria-expanded={searchOpen}
              aria-controls={searchOpen ? `${id}-search` : undefined}
              title={searchText.trim() ? `搜索：${searchText}` : "搜索常用命令"}
            >
              <SearchOutlined />
            </button>
          </Popover>
          <Tooltip title="新建命令">
            <button type="button" className="quickCommandCreateButton" aria-label="新建命令" onClick={() => onEditCommand()}>
              <PlusOutlined />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="quickCommandDockBody">
        {visibleCommands.length === 0 ? (
          <div className="quickCommandEmpty">
            <CodeOutlined />
            <strong>{commandItems.length === 0 ? "暂无常用命令" : "没有匹配的命令"}</strong>
            <span>{commandItems.length === 0 ? "点击右上角加号添加第一条命令" : "尝试搜索其他名称或脚本内容"}</span>
          </div>
        ) : (
          <div className="quickCommandCardList">
            {visibleCommands.map((item) => (
              <article key={item.id} className="quickCommandCard">
                <button
                  type="button"
                  className="quickCommandCardMain"
                  title={`运行：${item.name}`}
                  onClick={() => runCommand(item)}
                >
                  <span className="quickCommandCardIcon"><CodeOutlined /></span>
                  <span className="quickCommandCardCopy">
                    <span className="quickCommandCardNameLine">
                      <strong>{item.name}</strong>
                    </span>
                    <code title={item.command}>{item.command}</code>
                  </span>
                </button>

                <span className="quickCommandCardActions">
                  <Tooltip title="运行">
                    <button type="button" className="quickCommandRunButton" aria-label={`运行 ${item.name}`} onClick={() => runCommand(item)}>
                      <PlayCircleFilled />
                    </button>
                  </Tooltip>
                  <Dropdown menu={commandMenu(item)} placement="bottomRight" trigger={["click"]}>
                    <button type="button" className="quickCommandMoreButton" aria-label={`${item.name} 更多操作`}>
                      <EllipsisOutlined />
                    </button>
                  </Dropdown>
                </span>
              </article>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
