/**
 * ApiKeyPanel — User_Key 管理（组织与权限分组）。
 *
 * 精简版：列表只展示 4 个核心字段——key_id / user_id / key_prefix / 创建时间，
 * 不再展示「名称」「过期时间」两列（对应地，新建弹窗也不再要求填写名称）。
 * Tea 组件：列表用 Table + autotip，头部用 Justify + H3，
 * 破坏性操作统一走 Modal.confirm 二次确认，新建弹窗复用全站统一的 Modal 外壳。
 *
 * 后端链路：新面板（stateless）走 meta action `user-key/list|create|revoke`，
 * 由 Control 透明代理到内核 /v3/meta。前端不直接调内核，也不走旧 REST 路径。
 * owner 由登录 user_key 推断，前端不用也不能传别人的 user_id —— 天然满足
 * 「用户只能看到 / 管理自己的 key」。
 *
 * 安全设计（内核既有行为，不是本组件的取舍）：
 *   - list/get 仍不回传明文；完整 sk-mem 仅经主人 `user-key/reveal` 按需取得；
 *   - `key_prefix` 是内核给的可展示前缀（如 `sk-mem-ab12****`），用于免密识别
 *     具体是哪把 key，不等同于明文；
 *   - Key Prefix 旁复制图标：reveal → 剪贴板，格子里仍只显示 prefix。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Table,
  Card,
  Button,
  Alert,
  Copy,
  Text,
  DatePicker,
  Justify,
  H3,
  Form,
  Modal,
  Input,
} from 'tea-component';
import { AddIcon, FileCopyIcon } from 'tea-icons-react';
import { userKeysApi, metaInstancesApi, type UserKey } from '@/lib/teamApi';
import { formatMaasCacheTtlHint, getMaasCacheTtlMs } from '@/lib/maas-cache-ttl';
import { copyToClipboard } from '@/pages/ChatMemoryPage/utils/memory-utils';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import '../styles/api-key-panel.css';

const { autotip } = Table.addons;

export default function ApiKeyPanel() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const { auth } = useAuthStore();
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(true);
  // 客户端接入 base 地址（来自当前登录的 instance 元数据；每个实例不同）。
  // 优先取 proxy_endpoint —— 开源本地部署 core+proxy 分开时客户端要接的是 proxy；
  // 未配置时回落 gateway_endpoint，等同老行为（线上 gateway 前置 proxy，两者合一）。
  const [clientBaseUrl, setClientBaseUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.instance_id) {
      setClientBaseUrl(null);
      return;
    }
    void metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        const hit = list.find((i) => i.instance_id === auth.instance_id);
        setClientBaseUrl(hit?.proxy_endpoint ?? hit?.gateway_endpoint ?? null);
      })
      .catch(() => {
        if (!cancelled) setClientBaseUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [auth?.instance_id]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await userKeysApi.list();
      // 按创建时间倒序（内核未必保证顺序）
      list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      // 已吊销的 key 不再展示
      setKeys(list.filter((k) => !k.revoked_at));
    } catch (e) {
      tea.notify.error(e);
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- 新建弹窗 ----
  // 不再收集「名称」——列表本身也不展示名称列，创建时无需再让用户填写。
  const [showCreate, setShowCreate] = useState(false);
  const [newExpiresAt, setNewExpiresAt] = useState<Moment | null>(null);
  const [creating, setCreating] = useState(false);
  // 刚创建出来的 key（含完整明文，仅展示一次）
  const [freshKey, setFreshKey] = useState<{ keyId: string; secret: string } | null>(null);

  const [maasModalKey, setMaasModalKey] = useState<UserKey | null>(null);
  const [maasInput, setMaasInput] = useState('');
  const [maasSaving, setMaasSaving] = useState(false);
  /** 正在 reveal 的 key_id，防连点 */
  const [revealingId, setRevealingId] = useState<string | null>(null);

  const effectiveHint = formatMaasCacheTtlHint(getMaasCacheTtlMs(), t);
  const activeKeyCount = keys.filter((k) => !k.revoked_at).length;

  function isKeyExpired(key: UserKey): boolean {
    if (!key.expires_at) return false;
    const ms = new Date(key.expires_at).getTime();
    return !Number.isNaN(ms) && ms <= Date.now();
  }

  /** 仅主人可复制；admin 看别人列表时隐藏。过期/吊销禁用（依赖 API 兜底）。 */
  function canRevealCopy(key: UserKey): boolean {
    if (key.revoked_at) return false;
    if (key.user_id && auth?.user_id && key.user_id !== auth.user_id) return false;
    return true;
  }

  /** 最后一把 active key 禁止吊销（与 Core last_key_cannot_revoke 对齐）。 */
  function isLastActiveKey(key: UserKey): boolean {
    return !key.revoked_at && activeKeyCount <= 1;
  }

  async function handleRevealCopy(key: UserKey) {
    if (revealingId) return;
    setRevealingId(key.key_id);
    try {
      const { key_value } = await userKeysApi.reveal(key.key_id);
      const ok = await copyToClipboard(key_value);
      if (ok) {
        tea.notify.success(t('apiKey.copy.success'));
      } else {
        tea.notify.error(t('apiKey.copy.failed'));
      }
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setRevealingId(null);
    }
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const key = await userKeysApi.create({
        expires_at: newExpiresAt ? newExpiresAt.endOf('day').toISOString() : undefined,
      });
      setNewExpiresAt(null);
      setShowCreate(false);
      if (key.key_value) {
        setFreshKey({ keyId: key.key_id, secret: key.key_value });
      }
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(key: UserKey) {
    if (isLastActiveKey(key)) {
      tea.notify.warning(t('apiKey.revoke.lastDisabled'));
      return;
    }
    const ok = await tea.confirm({
      message: t('apiKey.confirm.revoke', { name: key.key_prefix || key.key_id }),
      description: t('apiKey.confirm.revoke.desc'),
      okText: t('apiKey.confirm.revoke.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    }
  }

  function openMaasModal(key: UserKey) {
    setMaasModalKey(key);
    setMaasInput('');
  }

  async function handleMaasSave() {
    if (!maasModalKey) return;
    setMaasSaving(true);
    try {
      await userKeysApi.setMaasKey({
        key_id: maasModalKey.key_id,
        maas_api_key: maasInput.trim(),
      });
      setMaasModalKey(null);
      setMaasInput('');
      tea.notify.success(t('apiKey.maas.saveSuccess', { effectiveHint }));
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setMaasSaving(false);
    }
  }

  async function handleMaasClear(key: UserKey) {
    const ok = await tea.confirm({
      message: t('apiKey.maas.confirm.clear'),
      description: t('apiKey.maas.confirm.clear.desc'),
      okText: t('apiKey.maas.confirm.clear.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.setMaasKey({ key_id: key.key_id, maas_api_key: '' });
      tea.notify.success(t('apiKey.maas.clearSuccess', { effectiveHint }));
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    }
  }

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return (
    <div className="_memory-apikey-body">
      {/* ===== 刚创建的 Key 提示（仅展示一次） ===== */}
      {freshKey && (
        <Alert type="success" onClose={() => setFreshKey(null)}>
          <div className="_memory-apikey-fresh">
            <p className="_memory-apikey-fresh-desc">
              {t('apiKey.fresh.desc', { keyId: freshKey.keyId })}
            </p>
            <div className="_memory-apikey-fresh-code-row">
              <code className="_memory-apikey-fresh-code">{freshKey.secret}</code>
              <Copy
                text={freshKey.secret}
                onCopy={() => {
                  // 复制成功后自动关闭完整 Key 显示，避免明文长时间停留在屏幕上
                  setFreshKey(null);
                }}
              />
            </div>
          </div>
        </Alert>
      )}

      {/* ===== 页面头部（Justify 左右布局） ===== */}
      <Justify
        left={
          <div>
            <H3>{t('apiKey.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('apiKey.desc')}
            </Text>
          </div>
        }
        right={
          role !== 'admin' ? (
            <Button
              type="primary"
              onClick={() => {
                setShowCreate(true);
                setNewExpiresAt(null);
              }}
              data-guide="create-key"
            >
              <AddIcon size={14} />
              {t('apiKey.create')}
            </Button>
          ) : null
        }
      />

      {/* ===== Key 列表：key_id / key_prefix / 创建时间 + 操作 ===== */}
      <Card>
        <Table
          verticalTop
          records={keys}
          recordKey="key_id"
          columns={[
            {
              key: 'key_id',
              header: t('apiKey.table.keyId'),
              render: (key) => (
                <Text
                  parent="code"
                  copyable
                  style={{
                    fontSize: 12,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {key.key_id}
                </Text>
              ),
            },
            {
              key: 'key_prefix',
              header: t('apiKey.table.keyPrefix'),
              render: (key) => {
                const showCopy = canRevealCopy(key);
                const expired = isKeyExpired(key);
                return (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 2,
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <Text parent="code" style={{ fontSize: 12 }}>
                      {key.key_prefix || '—'}
                    </Text>
                    {showCopy ? (
                      <Button
                        type="icon"
                        tooltip={t('apiKey.copy.tooltip')}
                        disabled={expired || revealingId === key.key_id}
                        onClick={() => void handleRevealCopy(key)}
                      >
                        <FileCopyIcon size={14} />
                      </Button>
                    ) : null}
                  </span>
                );
              },
            },
            {
              key: 'maas_key',
              header: t('apiKey.table.maasKey'),
              width: 220,
              render: (key) => (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {key.maas_configured ? (
                    <Text theme="text">
                      {key.maas_key_hint
                        ? t('apiKey.maas.hint', { hint: key.maas_key_hint })
                        : t('apiKey.maas.configured')}
                    </Text>
                  ) : (
                    <Text theme="weak">{t('apiKey.maas.notConfigured')}</Text>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button type="link" onClick={() => openMaasModal(key)}>
                      {key.maas_configured ? t('apiKey.maas.edit') : t('apiKey.maas.add')}
                    </Button>
                    {key.maas_configured ? (
                      <Button type="link" onClick={() => void handleMaasClear(key)}>
                        {t('apiKey.maas.clear')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ),
            },
            {
              key: 'created_at',
              header: t('apiKey.table.createdAt'),
              width: 180,
              render: (key) => <Text theme="text">{formatTime(key.created_at)}</Text>,
            },
            {
              key: 'expires_at',
              header: t('apiKey.table.expiresAt'),
              width: 180,
              render: (key) => {
                if (key.revoked_at) return <Text theme="weak">{t('apiKey.revoked')}</Text>;
                return key.expires_at ? (
                  <Text theme="text">{formatTime(key.expires_at)}</Text>
                ) : (
                  <Text theme="weak">{t('apiKey.neverExpire')}</Text>
                );
              },
            },
            {
              key: 'actions',
              header: t('apiKey.table.actions'),
              width: 100,
              align: 'right',
              render: (key) => {
                const lastOnly = isLastActiveKey(key);
                return (
                <Button
                  type="text"
                  disabled={!!key.revoked_at || lastOnly}
                  title={lastOnly ? t('apiKey.revoke.lastDisabled') : undefined}
                  onClick={() => void handleDelete(key)}
                >
                  {t('apiKey.revoke')}
                </Button>
                );
              },
            },
          ]}
          addons={[
            autotip({
              isLoading: loading,
              emptyText: (
                <div className="_memory-apikey-empty">
                  <div className="_memory-apikey-empty-title">{t('apiKey.empty.title')}</div>
                  <div className="_memory-apikey-empty-desc">{t('apiKey.empty.desc')}</div>
                </div>
              ),
              onRetry: () => void refresh(),
            }),
          ]}
        />
      </Card>

      {/* ===== 接入指引 ===== */}
      {/*
        instance-id 从当前登录态注入（auth.instance_id）—— 用户不用再手工替换
        [instance-id] 占位符，也不用去别处找自己现在连的是哪个实例。
        未登录理论上不会走到这个页（LoginGate 挡在外面），仍保留占位 fallback 兜底。
      */}
      <Card>
        <Card.Body title={t('apiKey.endpoint.title')}>
          {auth?.instance_name && (
            <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--tea-color-text-secondary)' }}>
              {t('apiKey.endpoint.current')}
              <code>{auth.instance_name}</code>
              <span style={{ opacity: 0.6, marginLeft: 6 }}>({auth.instance_id})</span>
            </div>
          )}
          <div className="_memory-apikey-endpoints">
            {(() => {
              // base 未拉到就显示加载中；防止用户误抄硬编码 URL
              if (!clientBaseUrl) {
                return (
                  <Text theme="weak" style={{ fontSize: 11 }}>
                    {t('apiKey.endpoint.loading')}
                  </Text>
                );
              }
              // 去掉结尾斜杠，避免 base + /path 拼成双斜杠（! 绕过闭包窄化）
              const base = clientBaseUrl!.replace(/\/+$/, '');
              const iid = auth?.instance_id ?? '[instance-id]';
              const endpoints: Array<{ label: string; url: string }> = [
                { label: 'CodeBuddy', url: `${base}/codebuddy/${iid}` },
                { label: 'Claude Code', url: `${base}/claude-code/${iid}` },
                // WorkBuddy 走 /workbuddy/<spaceId>（spaceId=instance_id，与 codebuddy 对称）。
                // 网页版底层 OpenAI ChatCompletions、桌面版 Responses API，proxy 均已适配。
                { label: 'WorkBuddy', url: `${base}/workbuddy/${iid}` },
                // codex 用 OpenAI Responses API（POST /v1/responses）；proxy 侧
                // 同时注册了 v1/无v1 两种路径，惯例用不带 /v1 的 base，客户端
                // config.toml 里 base_url 直接填这个地址即可，wire_api="responses"。
                { label: 'Codex', url: `${base}/codex/${iid}` },
                // dsh (deepseek-harness) — DeepSeek 官方 agent harness,Web UI 会话
                // 走 OpenAI Chat Completions。**尾巴不带 /v1** —— dsh 客户端
                // hardcoded 拼 ${baseURL}/chat/completions,与 CB 同族;proxy 侧
                // 路由 /dsh/{spaceId}/chat/completions 已对齐。用户填的 baseURL
                // 直接是这里的地址,不要在后面再加 /v1。
                { label: 'DeepSeek Harness (dsh)', url: `${base}/dsh/${iid}` },
                // OpenCode — sst/opencode 通用终端 AI 编程 Agent，协议 = 标准
                // OpenAI Chat Completions（POST /v1/chat/completions），与 CB/dsh 同族。
                // proxy 侧 agent-adapters/opencode.ts 已适配 form 回填 + mem: 命令族全套。
                { label: 'OpenCode', url: `${base}/opencode/${iid}` },
                { label: 'OpenClaw', url: `${base}/openclaw/default` },
                { label: 'Hermes', url: `${base}/hermes/default` },
              ];
              return endpoints.map((ep) => (
                <div className="_memory-apikey-endpoint" key={ep.label}>
                  <Text theme="label" parent="div" style={{ marginBottom: 4 }}>
                    {ep.label}
                  </Text>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code
                      style={{
                        flex: 1,
                        fontSize: 11,
                        wordBreak: 'break-all',
                        background: 'var(--tea-color-bg-secondary-default)',
                        padding: '4px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {ep.url}
                    </code>
                    <Copy text={ep.url}>
                      <Button>{t('apiKey.endpoint.copy')}</Button>
                    </Copy>
                  </div>
                </div>
              ));
            })()}
          </div>
        </Card.Body>
      </Card>
      {/* ===== 新建弹窗：只需设置「过期时间」（可留空＝永不过期），不再需要名称 ===== */}
      {showCreate && (
        <Modal
          visible
          caption={t('apiKey.create.caption')}
          size="s"
          onClose={() => setShowCreate(false)}
          disableEscape={creating}
        >
          <Modal.Body>
            <Form>
              <Form.Item
                label={t('apiKey.create.expiresAt')}
                extra={t('apiKey.create.expiresAt.extra')}
              >
                <DatePicker
                  value={newExpiresAt ?? undefined}
                  onChange={(v) => setNewExpiresAt(v)}
                  disabledDate={(d) => !d.isBefore(moment().startOf('day'))}
                  placeholder={t('apiKey.create.expiresAt.placeholder')}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
              loading={creating}
            >
              {t('apiKey.create.submit')}
            </Button>
            <Button onClick={() => setShowCreate(false)} disabled={creating}>
              {t('apiKey.create.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
      {maasModalKey && (
        <Modal
          visible
          caption={
            maasModalKey.maas_configured
              ? t('apiKey.maas.modal.titleEdit')
              : t('apiKey.maas.modal.titleAdd')
          }
          size="m"
          onClose={() => {
            if (!maasSaving) {
              setMaasModalKey(null);
              setMaasInput('');
            }
          }}
          disableEscape={maasSaving}
        >
          <Modal.Body>
            <Text theme="weak" parent="p" style={{ marginBottom: 12 }}>
              {t('apiKey.maas.modal.desc')}
            </Text>
            <Form>
              <Form.Item label={t('apiKey.table.maasKey')}>
                <Input
                  value={maasInput}
                  onChange={(v) => setMaasInput(v)}
                  placeholder={t('apiKey.maas.modal.placeholder')}
                  type="password"
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={() => void handleMaasSave()}
              disabled={maasSaving || !maasInput.trim()}
              loading={maasSaving}
            >
              {t('apiKey.maas.modal.submit')}
            </Button>
            <Button
              onClick={() => {
                setMaasModalKey(null);
                setMaasInput('');
              }}
              disabled={maasSaving}
            >
              {t('apiKey.maas.modal.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
