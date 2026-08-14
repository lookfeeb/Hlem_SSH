import {
  ApiOutlined,
  ArrowRightOutlined,
  CheckOutlined,
  CloudServerOutlined,
  CodeOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  LockOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  GlobalOutlined,
  UserOutlined,
  KeyOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { Button, Form, Input, InputNumber, Modal, Radio, Select, Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import { getErrorMessage } from "../lib/configMapping";
import { getGroupNameLengthError, GROUP_COUNT_ERROR, GROUP_CUSTOM_MAX_COUNT, GROUP_NAME_MAX_CHARS } from "../lib/groupName";
import { useMountedRef } from "../lib/reactLifecycle";
import type { SessionGroup, SessionInput } from "../types";

const GROUP_SELECT_OPTION_HEIGHT = 36;
const GROUP_SELECT_VISIBLE_COUNT = 5;
const GROUP_SELECT_LIST_HEIGHT = GROUP_SELECT_OPTION_HEIGHT * GROUP_SELECT_VISIBLE_COUNT;

function formatGroupActionError(error: unknown, fallback: string) {
  const message = getErrorMessage(error);
  return message === "操作失败" ? fallback : message;
}

interface SessionConfigModalProps {
  open: boolean;
  requestId: string;
  mode: "create" | "edit";
  initialValue: SessionInput;
  groups: SessionGroup[];
  existingSessions: { id: string; name: string; host: string }[];
  editingSessionId?: string;
  onCancel: () => void;
  onCancelButton?: () => void;
  onCreateGroup: (name: string) => Promise<string | null>;
  onUpdateGroup: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<string | null>;
  onSubmit: (input: SessionInput) => Promise<void>;
}

interface SessionFormValues {
  name: string;
  groupId?: string | null;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "privateKey";
  password?: string | null;
  privateKeyPath?: string | null;
  importedPrivateKey?: string | null;
  privateKeyPassphrase?: string | null;
  proxyMode: "global" | "custom";
  proxyKind: "socks5" | "httpConnect";
  proxyHost: string;
  proxyPort: number;
}

interface GroupSelectOption {
  label: string;
  value: string;
  group: SessionGroup;
}

export function SessionConfigModal({
  open,
  requestId,
  mode,
  initialValue,
  groups,
  existingSessions,
  editingSessionId,
  onCancel,
  onCancelButton,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onSubmit,
}: SessionConfigModalProps) {
  const [form] = Form.useForm<SessionFormValues>();
  const mountedRef = useMountedRef();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [fieldErrorCount, setFieldErrorCount] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const requestIdRef = useRef(requestId);
  requestIdRef.current = requestId;
  const watchedName = Form.useWatch("name", form);
  const watchedGroupId = Form.useWatch("groupId", form);
  const watchedHost = Form.useWatch("host", form);
  const watchedPort = Form.useWatch("port", form);
  const watchedUsername = Form.useWatch("username", form);
  const watchedAuthMethod = Form.useWatch("authMethod", form);
  const watchedPassword = Form.useWatch("password", form);
  const watchedPrivateKeyPath = Form.useWatch("privateKeyPath", form);
  const watchedProxyMode = Form.useWatch("proxyMode", form);
  const watchedProxyKind = Form.useWatch("proxyKind", form);
  const watchedProxyHost = Form.useWatch("proxyHost", form);
  const watchedProxyPort = Form.useWatch("proxyPort", form);

  const authMethod = watchedAuthMethod ?? initialValue.auth.method;
  const proxyMode = watchedProxyMode ?? proxyModeFromInput(initialValue);
  const host = watchedHost?.trim() ?? "";
  const username = watchedUsername?.trim() ?? "";
  const privateKeyPath = watchedPrivateKeyPath?.trim() ?? "";
  const importedPrivateKey = initialValue.auth.importedPrivateKey?.trim() ?? "";
  const passwordRequired = mode === "create" || initialValue.auth.method !== "password";
  const selectedGroupName = groups.find((group) => group.id === watchedGroupId)?.name ?? "未分组";
  const previewName = watchedName?.trim() || host || "未命名连接";
  const previewHost = host || "未填写主机";
  const previewUsername = username || "未填写用户";
  const privateKeyParts = privateKeyPath.split(/[\\/]/).filter(Boolean);
  const privateKeyName = privateKeyParts[privateKeyParts.length - 1];
  const authDetail =
    authMethod === "password"
      ? passwordRequired && !watchedPassword
        ? "尚未填写密码"
        : "使用登录密码"
      : privateKeyName
        ? "使用 " + privateKeyName
        : importedPrivateKey
          ? "使用已导入私钥"
          : "尚未选择私钥";
  const proxyKindLabel = watchedProxyKind === "httpConnect" ? "HTTP CONNECT" : "SOCKS5";
  const proxyDetail =
    proxyMode === "custom"
      ? proxyKindLabel + " · " + (watchedProxyHost?.trim() || "未填写地址")
      : "按全局设置自动选择";
  const requiredChecks = [
    !host,
    !watchedPort || watchedPort < 1 || watchedPort > 65535,
    !username,
    authMethod === "password" && passwordRequired && !watchedPassword,
    authMethod === "privateKey" && !privateKeyPath && !importedPrivateKey,
    proxyMode === "custom" && !watchedProxyHost?.trim(),
    proxyMode === "custom" && (!watchedProxyPort || watchedProxyPort < 1 || watchedProxyPort > 65535),
  ];
  const missingCount = requiredChecks.filter(Boolean).length;
  const ready = missingCount === 0 && fieldErrorCount === 0;
  const serverPreviewReady = Boolean(
    host &&
    username &&
    watchedPort &&
    watchedPort >= 1 &&
    watchedPort <= 65535,
  );
  const authPreviewReady =
    authMethod === "password"
      ? !passwordRequired || Boolean(watchedPassword)
      : Boolean(privateKeyPath || importedPrivateKey);
  const proxyPreviewReady =
    proxyMode === "global" || Boolean(
      watchedProxyHost?.trim() &&
      watchedProxyPort &&
      watchedProxyPort >= 1 &&
      watchedProxyPort <= 65535,
    );
  const previewCompletedCount = [serverPreviewReady, authPreviewReady, proxyPreviewReady]
    .filter(Boolean).length;
  const previewProgress = Math.round(previewCompletedCount / 3 * 100);

  function focusPreviewField(field: keyof SessionFormValues) {
    form.scrollToField(field, {
      behavior: "smooth",
      block: "center",
      focus: true,
    });
  }

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(toFormValues(initialValue, mode));
    setSubmitting(submittingRef.current);
    setFieldErrorCount(0);
    setSubmitError(null);
  }, [editingSessionId, form, mode, open, requestId]);

  useEffect(() => {
    if (!open) return;
    const hiddenFieldNames: (keyof SessionFormValues)[] = [
      ...(authMethod === "password" ? ["privateKeyPath", "privateKeyPassphrase"] as const : ["password"] as const),
      ...(proxyMode === "global" ? ["proxyHost", "proxyPort"] as const : []),
    ];
    form.setFields(hiddenFieldNames.map((name) => ({ name, errors: [] })));
    setFieldErrorCount(form.getFieldsError().filter((field) => field.errors.length > 0).length);
  }, [authMethod, form, open, proxyMode]);

  async function submit() {
    if (submittingRef.current) return;
    const submitRequestId = requestId;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const values = await form.validateFields();
      if (!mountedRef.current || requestIdRef.current !== submitRequestId) return;
      await onSubmit(toSessionInput(values, initialValue, mode));
    } catch (error) {
      if (!mountedRef.current || requestIdRef.current !== submitRequestId) return;
      if (error && typeof error === "object" && "errorFields" in error) {
        const errorFields = (error as { errorFields?: unknown[] }).errorFields;
        setFieldErrorCount(errorFields?.length ?? 0);
        return;
      }
      if (mountedRef.current && requestIdRef.current === submitRequestId) {
        setSubmitError(getErrorMessage(error));
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <Modal
      title={
        <div className="sessionConfigHeader">
          <div className="sessionConfigHeaderIcon" aria-hidden="true">
            <CodeOutlined />
          </div>
          <div className="sessionConfigHeaderCopy">
            <strong>{mode === "create" ? "新建 SSH 连接" : "编辑 SSH 连接"}</strong>
            <span>
              {mode === "create"
                ? "填写服务器地址与认证方式，保存后由你决定何时连接"
                : "保存只影响下次手动连接，已打开的终端保持当前连接"}
            </span>
          </div>
        </div>
      }
      open={open}
      width={1080}
      centered
      transitionName=""
      maskTransitionName=""
      onCancel={onCancel}
      footer={
        <div className="sessionConfigFooter">
          <div
            className={
              "sessionConfigFooterStatus" +
              (submitError || fieldErrorCount > 0 ? " is-error" : missingCount > 0 ? " is-incomplete" : "")
            }
            title={submitError ?? undefined}
          >
            <span className="sessionConfigFooterStatusIcon">
              {submitError || fieldErrorCount > 0 || missingCount > 0
                ? <ExclamationCircleOutlined />
                : <CheckOutlined />}
            </span>
            <span>
              {submitError
                ? submitError
                : fieldErrorCount > 0
                  ? "请修正表单中的校验错误"
                  : missingCount > 0
                    ? "还有 " + missingCount + " 项必填信息需要完成"
                    : mode === "create"
                      ? "必填信息已完成，可以保存连接"
                      : "必填信息已完成，可以保存更改"}
            </span>
          </div>
          <div className="sessionConfigFooterActions">
            <Button aria-label="取消" onClick={onCancelButton ?? onCancel} disabled={submitting}>
              取消
            </Button>
            <Button
              type="primary"
              aria-label={mode === "create" ? "保存连接" : "保存更改"}
              icon={<ArrowRightOutlined />}
              iconPlacement="end"
              loading={submitting}
              disabled={!ready}
              onClick={() => void submit()}
            >
              {mode === "create" ? "保存连接" : "保存更改"}
            </Button>
          </div>
        </div>
      }
      destroyOnHidden
      className="sessionConfigModal"
    >
      <div className="sessionConfigShell">
        <aside className="sessionConfigPreview" aria-label="连接配置实时预览">
          <div className="sessionPreviewTopline">
            <div className="sessionPreviewEyebrow">
              <span aria-hidden="true" />
              实时预览
            </div>
            <span className={"sessionPreviewProgressText" + (previewCompletedCount === 3 ? " is-ready" : "")}>
              {previewCompletedCount === 3 ? "配置完成" : previewCompletedCount + "/3 完成"}
            </span>
          </div>

          <div className="sessionPreviewHero">
            <div className="sessionPreviewServerIcon" aria-hidden="true">
              <CloudServerOutlined />
            </div>
            <div className="sessionPreviewIdentity">
              <strong className="sessionPreviewName" title={previewName}>{previewName}</strong>
              <div className={"sessionPreviewAddress" + (host ? "" : " is-empty")}>
                <span>{host ? previewUsername + "@" + previewHost : "等待填写主机地址"}</span>
                <small>SSH · 端口 {watchedPort || "—"}</small>
              </div>
            </div>
          </div>

          <div className="sessionPreviewTags">
            <span className="is-active">SSH</span>
            <span>{authMethod === "password" ? "密码认证" : "私钥认证"}</span>
            <span>{proxyMode === "custom" ? "自定义代理" : "跟随全局代理"}</span>
          </div>

          <div className="sessionPreviewProgress" aria-hidden="true">
            <span style={{ width: previewProgress + "%" }} />
          </div>

          <div className="sessionPreviewList" aria-label="配置完成情况">
            <button
              type="button"
              className={"sessionPreviewRow" + (serverPreviewReady ? " is-complete" : " is-pending")}
              aria-label="定位到服务器信息"
              onClick={() => focusPreviewField(
                !host ? "host" : !username ? "username" : !watchedPort || watchedPort < 1 || watchedPort > 65535 ? "port" : "name",
              )}
            >
              <span className="sessionPreviewStep">
                {serverPreviewReady ? <CheckOutlined /> : "01"}
              </span>
              <div><strong>服务器信息</strong><span>{selectedGroupName} · {previewUsername}</span></div>
              <ArrowRightOutlined className="sessionPreviewRowArrow" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={"sessionPreviewRow" + (authPreviewReady ? " is-complete" : " is-pending")}
              aria-label="定位到身份认证"
              onClick={() => focusPreviewField(
                authPreviewReady ? "authMethod" : authMethod === "password" ? "password" : "privateKeyPath",
              )}
            >
              <span className="sessionPreviewStep">
                {authPreviewReady ? <CheckOutlined /> : "02"}
              </span>
              <div><strong>身份认证</strong><span>{authDetail}</span></div>
              <ArrowRightOutlined className="sessionPreviewRowArrow" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={"sessionPreviewRow" + (proxyPreviewReady ? " is-complete" : " is-pending")}
              aria-label="定位到网络路径"
              onClick={() => focusPreviewField(
                proxyPreviewReady
                  ? "proxyMode"
                  : !watchedProxyHost?.trim()
                    ? "proxyHost"
                    : "proxyPort",
              )}
            >
              <span className="sessionPreviewStep">
                {proxyPreviewReady ? <CheckOutlined /> : "03"}
              </span>
              <div><strong>网络路径</strong><span>{proxyDetail}</span></div>
              <ArrowRightOutlined className="sessionPreviewRowArrow" aria-hidden="true" />
            </button>
          </div>
          <div className="sessionPreviewSecurity">
            <span><SafetyCertificateOutlined /></span>
            <p>凭证将加密保存在本机，不会上传到远程服务。</p>
          </div>
        </aside>

        <div className="sessionConfigFormPane">
          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            autoComplete="off"
            className="sessionConfigForm"
            onValuesChange={() => {
              setSubmitError(null);
              setFieldErrorCount(form.getFieldsError().filter((field) => field.errors.length > 0).length);
            }}
            onFieldsChange={() => {
              setFieldErrorCount(form.getFieldsError().filter((field) => field.errors.length > 0).length);
            }}
          >
            <BaseFields
              requestId={requestId}
              mode={mode}
              initialAuthMethod={initialValue.auth.method}
              hasImportedPrivateKey={Boolean(initialValue.auth.importedPrivateKey)}
              groups={groups}
              onCreateGroup={onCreateGroup}
              onUpdateGroup={onUpdateGroup}
              onDeleteGroup={onDeleteGroup}
              authMethod={authMethod}
              proxyMode={proxyMode}
              existingSessions={existingSessions}
              editingSessionId={editingSessionId}
            />
          </Form>
        </div>
      </div>
    </Modal>
  );
}

function BaseFields({
  requestId,
  mode,
  initialAuthMethod,
  hasImportedPrivateKey,
  groups,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  authMethod,
  proxyMode,
  existingSessions,
  editingSessionId,
}: {
  requestId: string;
  mode: "create" | "edit";
  initialAuthMethod: "password" | "privateKey";
  hasImportedPrivateKey: boolean;
  groups: SessionGroup[];
  onCreateGroup: (name: string) => Promise<string | null>;
  onUpdateGroup: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<string | null>;
  authMethod: "password" | "privateKey";
  proxyMode: "global" | "custom";
  existingSessions: { id: string; name: string; host: string }[];
  editingSessionId?: string;
}) {
  const passwordRequired = mode === "create" || initialAuthMethod !== "password";

  return (
    <>
      <section className="sessionConfigSection">
        <div className="sessionConfigSectionHeading">
          <div className="sessionConfigSectionTitle">
            <span>01</span>
            <strong>服务器信息</strong>
          </div>
          <small>用于在连接列表中识别这台主机</small>
        </div>
        <div className="sessionIdentityGrid">
          <Form.Item
            label="连接名称"
            name="name"
            extra="留空则自动生成连接名称"
            rules={[{
              validator: (_, value) => {
                if (!value || !value.trim()) return Promise.resolve();
                const duplicate = existingSessions.find(
                  (s) => s.name === value.trim() && s.id !== editingSessionId,
                );
                return duplicate ? Promise.reject("该名称已存在") : Promise.resolve();
              },
            }]}
          >
            <Input placeholder="生产服务器" autoComplete="off" prefix={<EditOutlined style={{ color: "var(--text-muted)" }} />} />
          </Form.Item>
          <GroupSelectField
            requestId={requestId}
            groups={groups}
            onCreateGroup={onCreateGroup}
            onUpdateGroup={onUpdateGroup}
            onDeleteGroup={onDeleteGroup}
          />
        </div>
        <div className="sessionEndpointGrid">
          <Form.Item
            label={<span>主机地址 <b className="sessionRequiredMark">*</b></span>}
            name="host"
            rules={[
              { required: true, message: "请输入主机地址" },
              {
                validator: (_, value) => {
                  if (!value || !value.trim()) return Promise.resolve();
                  const duplicate = existingSessions.find(
                    (s) => s.host === value.trim() && s.id !== editingSessionId,
                  );
                  return duplicate
                    ? Promise.reject(`该主机已存在（${duplicate.name}）`)
                    : Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="192.168.1.10" autoComplete="off" prefix={<GlobalOutlined style={{ color: "var(--text-muted)" }} />} />
          </Form.Item>
          <Form.Item
            label={<span>端口 <b className="sessionRequiredMark">*</b></span>}
            name="port"
            rules={[
              { required: true, message: "请输入端口" },
              { type: "number", min: 1, max: 65535, message: "端口范围为 1–65535" },
            ]}
          >
            <InputNumber min={1} max={65535} precision={0} className="fullControl" autoComplete="off" prefix={<LinkOutlined style={{ color: "var(--text-muted)" }} />} />
          </Form.Item>
          <Form.Item
            label={<span>用户名 <b className="sessionRequiredMark">*</b></span>}
            name="username"
            rules={[{ required: true, whitespace: true, message: "请输入用户名" }]}
          >
            <Input placeholder="root" autoComplete="off" prefix={<UserOutlined style={{ color: "var(--text-muted)" }} />} />
          </Form.Item>
        </div>
      </section>

      <section className="sessionConfigSection">
        <div className="sessionConfigSectionHeading">
          <div className="sessionConfigSectionTitle">
            <span>02</span>
            <strong>身份认证</strong>
          </div>
          <small>切换方式后仅校验当前可见字段</small>
        </div>
        <div className="sessionAuthGrid">
          <div>
            <Form.Item label="认证方式" name="authMethod" className="sessionAuthMethodField">
            <Radio.Group
              className="sessionAuthSwitch"
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: "密码", value: "password" },
                { label: "私钥", value: "privateKey" },
              ]}
            />
            </Form.Item>
            <span className="sessionFieldHint">凭证仅保存在本机</span>
          </div>
          <div className="sessionAuthPanel">
            {authMethod === "password" && (
              <Form.Item
                label={<span>登录密码 {passwordRequired && <b className="sessionRequiredMark">*</b>}</span>}
                name="password"
                rules={passwordRequired ? [{ required: true, message: "请输入登录密码" }] : undefined}
                extra={mode === "edit" && !passwordRequired ? "留空将继续使用已保存的密码" : undefined}
              >
                <Input.Password
                  placeholder={passwordRequired ? "输入登录密码" : "已保存的密码不会回显"}
                  autoComplete="new-password"
                  prefix={<LockOutlined style={{ color: "var(--text-muted)" }} />}
                />
              </Form.Item>
            )}
            {authMethod === "privateKey" && (
              <>
                <div className="sessionKeyGrid">
                  <PrivateKeyPathField requestId={requestId} hasImportedPrivateKey={hasImportedPrivateKey} />
                  <Form.Item label="私钥口令" name="privateKeyPassphrase" extra="无口令请留空">
                    <Input.Password
                      placeholder={mode === "create" ? "可选" : "留空则保持不变"}
                      autoComplete="new-password"
                      prefix={<LockOutlined style={{ color: "var(--text-muted)" }} />}
                    />
                  </Form.Item>
                </div>
                <div className="sessionInlineNote">
                  <span>i</span>
                  支持 OpenSSH、PEM、PPK 等格式；创建连接前仅检查私钥是否已选择。
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="sessionConfigSection sessionNetworkSection">
        <div className="sessionConfigSectionHeading">
          <div className="sessionConfigSectionTitle">
            <span>03</span>
            <strong>网络路径</strong>
          </div>
          <small>大多数情况下保持默认即可</small>
        </div>
        <Form.Item name="proxyMode" className="sessionRouteFormItem">
            <Radio.Group
              className="sessionRouteOptions"
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="global">
                <span className="sessionRouteIcon"><GlobalOutlined /></span>
                <span className="sessionRouteCopy">
                  <strong>跟随全局设置</strong>
                  <small>继承应用设置，未配置代理时直接连接</small>
                </span>
                <span className="sessionRouteDot" />
              </Radio.Button>
              <Radio.Button value="custom">
                <span className="sessionRouteIcon"><ApiOutlined /></span>
                <span className="sessionRouteCopy">
                  <strong>单独指定代理</strong>
                  <small>只为当前连接配置 SOCKS5 或 HTTP</small>
                </span>
                <span className="sessionRouteDot" />
              </Radio.Button>
            </Radio.Group>
        </Form.Item>
        {proxyMode === "global" && (
          <div className="sessionGlobalProxyDetail">
            <span>●</span>
            <p><strong>当前策略：</strong>继承全局代理配置，未启用时自动直连</p>
          </div>
        )}
        {proxyMode === "custom" && (
          <div className="sessionProxyPanel">
            <div className="sessionProxyGrid">
              <Form.Item label="代理类型" name="proxyKind">
                <Select
                  options={[
                    { label: "SOCKS5", value: "socks5" },
                    { label: "HTTP CONNECT", value: "httpConnect" },
                  ]}
                />
              </Form.Item>
              <Form.Item
                label={<span>代理地址 <b className="sessionRequiredMark">*</b></span>}
                name="proxyHost"
                rules={[{ required: true, whitespace: true, message: "请输入代理地址" }]}
              >
                <Input placeholder="127.0.0.1" autoComplete="off" prefix={<GlobalOutlined style={{ color: "var(--text-muted)" }} />} />
              </Form.Item>
              <Form.Item
                label={<span>端口 <b className="sessionRequiredMark">*</b></span>}
                name="proxyPort"
                rules={[
                  { required: true, message: "请输入代理端口" },
                  { type: "number", min: 1, max: 65535, message: "端口范围为 1–65535" },
                ]}
              >
                <InputNumber min={1} max={65535} precision={0} className="fullControl" autoComplete="off" prefix={<LinkOutlined style={{ color: "var(--text-muted)" }} />} />
              </Form.Item>
            </div>
            <div className="sessionInlineNote">
              <span>i</span>
              代理只负责建立 SSH 通道，终端与 SFTP 将复用同一连接策略。
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function GroupSelectField({
  requestId,
  groups,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
}: {
  requestId: string;
  groups: SessionGroup[];
  onCreateGroup: (name: string) => Promise<string | null>;
  onUpdateGroup: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<string | null>;
}) {
  const form = Form.useFormInstance<SessionFormValues>();
  const mountedRef = useMountedRef();
  const [newGroupName, setNewGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [groupActionError, setGroupActionError] = useState<string | null>(null);
  const [groupNameOverrides, setGroupNameOverrides] = useState<Record<string, string>>({});
  const requestIdRef = useRef(requestId);
  requestIdRef.current = requestId;
  const trimmedName = newGroupName.trim();
  const newGroupNameLengthError = getGroupNameLengthError(trimmedName);
  const editingGroupNameLengthError = editingGroupId ? getGroupNameLengthError(editingGroupName) : null;
  const defaultGroupId = groups.find((group) => group.sortOrder === 0)?.id ?? groups[0]?.id ?? null;
  const customGroupCount = groups.filter((group) => group.id !== defaultGroupId).length;
  const existingGroupForNewName = groups.find((group) => getGroupDisplayName(group) === trimmedName);
  const newGroupCountError =
    trimmedName && !existingGroupForNewName && customGroupCount >= GROUP_CUSTOM_MAX_COUNT ? GROUP_COUNT_ERROR : null;
  const groupOptions: GroupSelectOption[] = groups.map((group) => ({
    label: getGroupDisplayName(group),
    value: group.id,
    group,
  }));
  const groupSelectKey = groupOptions.map((option) => `${option.value}:${option.label}`).join("|");

  useEffect(() => {
    setNewGroupName("");
    setCreating(false);
    setCreateError(null);
    setEditingGroupId(null);
    setEditingGroupName("");
    setConfirmDeleteGroupId(null);
    setBusyGroupId(null);
    setGroupActionError(null);
    setGroupNameOverrides({});
  }, [requestId]);

  useEffect(() => {
    setGroupNameOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const [groupId, name] of Object.entries(current)) {
        const group = groups.find((item) => item.id === groupId);
        if (!group || group.name === name) {
          delete next[groupId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [groups]);

  function isDefaultGroup(group: SessionGroup) {
    return group.id === defaultGroupId;
  }

  function getGroupDisplayName(group: SessionGroup) {
    return groupNameOverrides[group.id] ?? group.name;
  }

  async function createGroup() {
    if (!trimmedName || creating) return;
    if (newGroupNameLengthError) {
      setCreateError(newGroupNameLengthError);
      return;
    }
    if (existingGroupForNewName) {
      form.setFieldValue("groupId", existingGroupForNewName.id);
      setNewGroupName("");
      setCreateError(null);
      return;
    }
    if (newGroupCountError) {
      setCreateError(newGroupCountError);
      return;
    }

    const actionRequestId = requestId;
    setCreating(true);
    setCreateError(null);
    try {
      const groupId = await onCreateGroup(trimmedName);
      if (!mountedRef.current || requestIdRef.current !== actionRequestId) return;
      if (groupId) form.setFieldValue("groupId", groupId);
      setNewGroupName("");
      setGroupActionError(null);
    } catch (error) {
      if (mountedRef.current && requestIdRef.current === actionRequestId) {
        setCreateError(formatGroupActionError(error, "创建分组失败"));
      }
    } finally {
      if (mountedRef.current && requestIdRef.current === actionRequestId) setCreating(false);
    }
  }

  async function updateGroup(group: SessionGroup) {
    const nextName = editingGroupName.trim();
    if (!nextName || busyGroupId) return;
    const lengthError = getGroupNameLengthError(nextName);
    if (lengthError) {
      setGroupActionError(lengthError);
      return;
    }
    if (nextName === getGroupDisplayName(group)) {
      setEditingGroupId(null);
      setEditingGroupName("");
      return;
    }
    const existingGroup = groups.find((item) => item.id !== group.id && getGroupDisplayName(item) === nextName);
    if (existingGroup) {
      form.setFieldValue("groupId", existingGroup.id);
      setEditingGroupId(null);
      setEditingGroupName("");
      setGroupActionError(null);
      return;
    }

    const actionRequestId = requestId;
    setBusyGroupId(group.id);
    setGroupActionError(null);
    try {
      await onUpdateGroup(group.id, nextName);
      if (!mountedRef.current || requestIdRef.current !== actionRequestId) return;
      setGroupNameOverrides((current) => ({ ...current, [group.id]: nextName }));
      if (form.getFieldValue("groupId") === group.id) {
        form.setFieldValue("groupId", group.id);
      }
      setEditingGroupId(null);
      setEditingGroupName("");
    } catch (error) {
      if (mountedRef.current && requestIdRef.current === actionRequestId) {
        setGroupActionError(formatGroupActionError(error, "重命名分组失败"));
      }
    } finally {
      if (mountedRef.current && requestIdRef.current === actionRequestId) setBusyGroupId(null);
    }
  }

  async function deleteGroup(group: SessionGroup) {
    if (busyGroupId) return;
    const actionRequestId = requestId;
    setBusyGroupId(group.id);
    setGroupActionError(null);
    try {
      const fallbackGroupId = await onDeleteGroup(group.id);
      if (!mountedRef.current || requestIdRef.current !== actionRequestId) return;
      if (form.getFieldValue("groupId") === group.id) {
        form.setFieldValue("groupId", fallbackGroupId);
      }
      setConfirmDeleteGroupId(null);
      setEditingGroupId(null);
      setEditingGroupName("");
    } catch (error) {
      if (mountedRef.current && requestIdRef.current === actionRequestId) {
        setGroupActionError(formatGroupActionError(error, "删除分组失败"));
      }
    } finally {
      if (mountedRef.current && requestIdRef.current === actionRequestId) setBusyGroupId(null);
    }
  }

  function startEdit(group: SessionGroup) {
    setEditingGroupId(group.id);
    setEditingGroupName(getGroupDisplayName(group));
    setConfirmDeleteGroupId(null);
    setGroupActionError(null);
  }

  function resetTransientGroupState() {
    setEditingGroupId(null);
    setEditingGroupName("");
    setConfirmDeleteGroupId(null);
    setGroupActionError(null);
  }

  function renderGroupOption(group: SessionGroup) {
    const defaultGroup = isDefaultGroup(group);
    const editing = editingGroupId === group.id;
    const confirmingDelete = confirmDeleteGroupId === group.id;
    const busy = busyGroupId === group.id;

    if (editing) {
      return (
        <div className="sessionGroupOption sessionGroupOption-editing" onMouseDown={(event) => event.stopPropagation()}>
          <Input
            className="sessionGroupRenameInput"
            value={editingGroupName}
            autoFocus
            maxLength={GROUP_NAME_MAX_CHARS}
            onChange={(event) => {
              setEditingGroupName(event.target.value);
              setGroupActionError(null);
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                void updateGroup(group);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setEditingGroupId(null);
                setEditingGroupName("");
              }
            }}
          />
          <span className="sessionGroupOptionActions">
            <Tooltip title="保存">
              <Button
                aria-label="保存分组名称"
                className="sessionGroupOptionButton sessionGroupOptionButton-save"
                type="text"
                icon={<CheckOutlined />}
                loading={busy}
                disabled={!editingGroupName.trim() || !!editingGroupNameLengthError}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void updateGroup(group);
                }}
              />
            </Tooltip>
            <Tooltip title="取消">
              <Button
                aria-label="取消重命名"
                className="sessionGroupOptionButton"
                type="text"
                icon={<CloseOutlined />}
                disabled={busy}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditingGroupId(null);
                  setEditingGroupName("");
                }}
              />
            </Tooltip>
          </span>
        </div>
      );
    }

    return (
      <div className={`sessionGroupOption${defaultGroup ? " sessionGroupOption-default" : ""}`}>
        <span className="sessionGroupOptionName">{getGroupDisplayName(group)}</span>
        <span className="sessionGroupOptionActions" onMouseDown={(event) => event.stopPropagation()}>
          {defaultGroup ? (
            <Tooltip title="默认分组不可重命名或删除">
              <span className="sessionGroupLockIcon" aria-label="默认分组锁定">
                <LockOutlined />
              </span>
            </Tooltip>
          ) : confirmingDelete ? (
            <>
              <Tooltip title="删除">
                <Button
                  aria-label="确认删除分组"
                  className="sessionGroupOptionButton sessionGroupOptionButton-danger"
                  type="text"
                  icon={<CheckOutlined />}
                  loading={busy}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void deleteGroup(group);
                  }}
                />
              </Tooltip>
              <Tooltip title="取消">
                <Button
                  aria-label="取消删除分组"
                  className="sessionGroupOptionButton"
                  type="text"
                  icon={<CloseOutlined />}
                  disabled={busy}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirmDeleteGroupId(null);
                  }}
                />
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip title="重命名">
                <Button
                  aria-label={`重命名 ${getGroupDisplayName(group)}`}
                  className="sessionGroupOptionButton"
                  type="text"
                  icon={<EditOutlined />}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    startEdit(group);
                  }}
                />
              </Tooltip>
              <Tooltip title="删除">
                <Button
                  aria-label={`删除 ${getGroupDisplayName(group)}`}
                  className="sessionGroupOptionButton sessionGroupOptionButton-danger"
                  type="text"
                  icon={<DeleteOutlined />}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirmDeleteGroupId(group.id);
                    setEditingGroupId(null);
                    setGroupActionError(null);
                  }}
                />
              </Tooltip>
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <Form.Item label="分组" name="groupId" extra="可在下拉列表底部新建分组">
      <Select<string, GroupSelectOption>
        key={groupSelectKey}
        allowClear
        classNames={{ popup: { root: "sessionGroupSelectPopup" } }}
        listHeight={GROUP_SELECT_LIST_HEIGHT}
        onOpenChange={(open) => {
          if (!open) resetTransientGroupState();
        }}
        placeholder="不分组"
        options={groupOptions}
        optionRender={(option) => renderGroupOption(option.data.group)}
        popupRender={(menu) => (
          <>
            {menu}
            {groupActionError && <div className="sessionGroupActionError">{groupActionError}</div>}
            {editingGroupNameLengthError && <div className="sessionGroupActionError">{editingGroupNameLengthError}</div>}
            <div className="sessionGroupCreatePanel" onMouseDown={(event) => event.stopPropagation()}>
              <Input
                className="sessionGroupCreateInput"
                placeholder="新分组名称"
                value={newGroupName}
                maxLength={GROUP_NAME_MAX_CHARS}
                onChange={(event) => {
                  setNewGroupName(event.target.value);
                  setCreateError(null);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createGroup();
                  }
                }}
              />
              <Tooltip title="新建分组">
                <Button
                  aria-label="新建分组"
                  className="sessionGroupCreateButton"
                  type="text"
                  icon={<PlusOutlined />}
                  loading={creating}
                  disabled={!trimmedName || !!newGroupNameLengthError || !!newGroupCountError}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void createGroup();
                  }}
                />
              </Tooltip>
              {(createError || newGroupNameLengthError || newGroupCountError) && (
                <div className="sessionGroupCreateError">{createError || newGroupNameLengthError || newGroupCountError}</div>
              )}
            </div>
          </>
        )}
      />
    </Form.Item>
  );
}

/** 私钥路径字段：含系统文件选择器按钮（Tauri dialog） */
function PrivateKeyPathField({
  requestId,
  hasImportedPrivateKey,
}: {
  requestId: string;
  hasImportedPrivateKey: boolean;
}) {
  const form = Form.useFormInstance<SessionFormValues>();
  const mountedRef = useMountedRef();
  const requestIdRef = useRef(requestId);
  requestIdRef.current = requestId;

  async function browse() {
    const pickerRequestId = requestId;
    try {
      // 动态导入，避免在非 Tauri 环境中报错
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "选择私钥文件",
        multiple: false,
        filters: [
          { name: "私钥文件", extensions: ["pem", "key", "ppk", "rsa", "ed25519"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (
        mountedRef.current
        && requestIdRef.current === pickerRequestId
        && typeof selected === "string"
        && selected
      ) {
        form.setFieldValue("privateKeyPath", selected);
      }
    } catch (error) {
      console.debug("[helm] failed to open private key picker:", getErrorMessage(error));
    }
  }

  return (
    <Form.Item
      label={<span>私钥文件 <b className="sessionRequiredMark">*</b></span>}
      name="privateKeyPath"
      rules={[
        {
          validator: (_, value) =>
            value?.trim() || hasImportedPrivateKey
              ? Promise.resolve()
              : Promise.reject("请选择私钥文件"),
        },
      ]}
    >
      <Input
        className="privateKeyPathInput"
        placeholder="选择或输入私钥文件路径"
        autoComplete="off"
        prefix={<KeyOutlined style={{ color: "var(--text-muted)" }} />}
        suffix={
          <Tooltip title="浏览私钥文件">
            <Button
              aria-label="浏览私钥文件"
              className="privateKeyBrowseButton"
              type="text"
              icon={<FolderOpenOutlined />}
              onClick={browse}
            />
          </Tooltip>
        }
      />
    </Form.Item>
  );
}

function toFormValues(input: SessionInput, mode: "create" | "edit"): SessionFormValues {
  const proxy = input.ssh.proxy;
  return {
    name: mode === "create" ? "" : input.name,
    groupId: input.groupId ?? null,
    host: mode === "create" ? "" : input.host,
    port: input.port,
    username: mode === "create" ? "root" : input.username,
    authMethod: mode === "create" ? "password" : input.auth.method,
    password: null,
    privateKeyPath: mode === "create" ? null : input.auth.privateKeyPath ?? null,
    importedPrivateKey: mode === "create" ? null : input.auth.importedPrivateKey ?? null,
    privateKeyPassphrase: null,
    proxyMode: proxyModeFromInput(input),
    proxyKind: proxy?.kind === "httpConnect" ? "httpConnect" : "socks5",
    proxyHost: proxy?.host || "127.0.0.1",
    proxyPort: proxy?.port || 1080,
  };
}

function toSessionInput(values: SessionFormValues, previous: SessionInput, mode: "create" | "edit"): SessionInput {
  const password = cleanOptional(values.password);
  const privateKeyPassphrase = cleanOptional(values.privateKeyPassphrase);
  const auth =
    values.authMethod === "privateKey"
      ? {
          method: "privateKey" as const,
          password: null,
          privateKeyPath: cleanOptional(values.privateKeyPath),
          importedPrivateKey: cleanOptional(values.importedPrivateKey),
          privateKeyPassphrase:
            privateKeyPassphrase ??
            (mode === "edit" && previous.auth.method === "privateKey" ? previous.auth.privateKeyPassphrase ?? null : null),
        }
      : {
          method: "password" as const,
          password: password ?? (mode === "edit" && previous.auth.method === "password" ? previous.auth.password ?? null : null),
          privateKeyPath: null,
          importedPrivateKey: null,
          privateKeyPassphrase: null,
        };

  return {
    name: values.name.trim(),
    groupId: values.groupId ?? null,
    host: values.host.trim(),
    port: values.port,
    username: values.username.trim(),
    auth,
    ssh: {
      ...previous.ssh,
      connectTimeoutMs: 10000,
      keepaliveIntervalSec: 15,
      proxy: proxyFromValues(values),
    },
    defaultPath: "",
    tags: previous.tags,
    note: previous.note ?? null,
    terminal: {
      ...previous.terminal,
      encoding: "utf-8",
      theme: "default",
      keepaliveIntervalSec: 15,
    },
    sftp: {
      ...previous.sftp,
      defaultPath: "",
      showHidden: false,
    },
  };
}

function cleanOptional(value?: string | null): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function proxyModeFromInput(input: SessionInput): SessionFormValues["proxyMode"] {
  const proxy = input.ssh.proxy;
  if (!proxy) return "global";
  if (proxy.kind === "direct") return "global";
  return "custom";
}

function proxyFromValues(values: SessionFormValues): SessionInput["ssh"]["proxy"] {
  if (values.proxyMode === "global") return null;
  return {
    kind: values.proxyKind,
    host: values.proxyHost.trim(),
    port: values.proxyPort,
  };
}
