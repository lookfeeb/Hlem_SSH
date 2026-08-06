export interface EditorInitMessage {
  type: "init";
  path: string;
  content: string;
  sessionId: string;
  sessionName: string;
  sessionHost: string;
}

export interface EditorAddTabMessage {
  type: "addTab";
  path: string;
  content: string;
  sessionId: string;
  sessionName: string;
  sessionHost: string;
}

export interface EditorSaveMessage {
  type: "save";
  path: string;
  content: string;
  sessionId: string;
  saveId: string;
}

export interface EditorSavedMessage {
  type: "saved";
  path: string;
  sessionId: string;
  saveId: string;
  content: string;
}

export interface EditorErrorMessage {
  type: "error";
  message: string;
  path?: string;
  sessionId?: string;
  saveId?: string;
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

export interface EditorRequestSessionMetadataMessage {
  type: "requestSessionMetadata";
  sessionIds: string[];
}

export interface EditorSessionMetadataMessage {
  type: "sessionMetadata";
  sessionId: string;
  sessionName: string;
  sessionHost: string;
}

export type EditorChannelMessage =
  | EditorInitMessage
  | EditorAddTabMessage
  | EditorSaveMessage
  | EditorSavedMessage
  | EditorErrorMessage
  | EditorReadyMessage
  | EditorCloseMessage
  | EditorSessionDisconnectedMessage
  | EditorSessionReconnectedMessage
  | EditorRequestSessionMetadataMessage
  | EditorSessionMetadataMessage;

export const EDITOR_CHANNEL_NAME = "helm-editor-global";
