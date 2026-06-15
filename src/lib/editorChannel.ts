export interface EditorInitMessage {
  type: "init";
  path: string;
  content: string;
  sessionId: string;
  sessionName: string;
}

export interface EditorAddTabMessage {
  type: "addTab";
  path: string;
  content: string;
  sessionId: string;
  sessionName: string;
}

export interface EditorChangeMessage {
  type: "change";
  path: string;
  content: string;
  sessionId: string;
}

export interface EditorSaveMessage {
  type: "save";
  path: string;
  content: string;
  sessionId: string;
}

export interface EditorSavedMessage {
  type: "saved";
  path: string;
  sessionId: string;
}

export interface EditorErrorMessage {
  type: "error";
  message: string;
  path?: string;
  sessionId?: string;
}

export interface EditorReadyMessage {
  type: "ready";
}

export interface EditorCloseMessage {
  type: "close";
}

export interface EditorSessionDisconnectedMessage {
  type: "sessionDisconnected";
  sessionId: string;
}

export interface EditorSessionReconnectedMessage {
  type: "sessionReconnected";
  sessionId: string;
}

export type EditorChannelMessage =
  | EditorInitMessage
  | EditorAddTabMessage
  | EditorChangeMessage
  | EditorSaveMessage
  | EditorSavedMessage
  | EditorErrorMessage
  | EditorReadyMessage
  | EditorCloseMessage
  | EditorSessionDisconnectedMessage
  | EditorSessionReconnectedMessage;

export const EDITOR_CHANNEL_NAME = "helm-editor-global";
