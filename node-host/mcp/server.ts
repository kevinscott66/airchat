/**
 * Инструменты AirChat, выставленные наружу по протоколу MCP.
 *
 * Здесь только схемы и описания; вся работа — в `tools.ts`. Разделение нужно
 * затем, чтобы сценарий проверки мог вызвать ту же логику напрямую, без
 * клиента и сокета, и чтобы описание инструмента нельзя было исправить, не
 * заметив, что оно разошлось с делом.
 *
 * ─── Чего в списке нет ──────────────────────────────────────────────────────
 *
 * Управления туннелем OpenFlux и настроек приложения. Не потому, что «руки не
 * дошли»: туннель поднимает нативный модуль в процессе приложения, а настройки
 * приложения — это то, что человек видит на экране телефона. Отсюда, из
 * процесса на сервере, ни того, ни другого не существует. Инструмент, который
 * отвечал бы «включено», ничего при этом не включив, — не заглушка, а ложь;
 * этим честно занимается мост внутри приложения (ветка `feat/agent-bridge`).
 *
 * Нет и звонков, ленты, групп, вложений: без WebRTC, IPFS и нативных модулей
 * они здесь либо не работают вовсе, либо работают наполовину.
 *
 * ─── Почему отказ приходит как ошибка инструмента ───────────────────────────
 *
 * У отказов тут два рода: «не смог прочитать» и «не стал делать». Оба
 * возвращаются с `isError: true` и разобранной причиной внутри. Успех с
 * припиской «вообще-то не вышло» агент почти наверняка прочитает как успех —
 * а половина отказов ядра именно так и выглядит, если их не назвать.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import * as tools from './tools';

/** Ответ инструмента: текст с разобранным JSON, отказ помечен как ошибка. */
function reply(result: tools.Result<unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(result.ok ? {} : { isError: true }),
  };
}

const contactArg = z
  .string()
  .describe('Собеседник: did:key:…, airchat://…, ссылка на профиль или открытый ключ в base64');

const cursorArg = z
  .object({
    createdAt: z.number().describe('Время создания самой старой отданной строки'),
    id: z.string().describe('Её идентификатор'),
  })
  .describe('Курсор из поля cursor прошлого ответа; без него отдаётся самая свежая страница');

export const SERVER_NAME = 'airchat-node-host';

export function createServer(version: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      instructions:
        'Аккаунт AirChat, запущенный без телефона. Видны только те переписки, ' +
        'что пришли по релею с момента запуска этого процесса: история с ' +
        'устройства сюда не синхронизируется. Отказы приходят с причиной — ' +
        'blocked, rate_limited, no_session, no_route, read_failed, write_failed; ' +
        'read_failed означает «прочитать не удалось», а не «ничего нет».',
    }
  );

  server.registerTool(
    'status',
    {
      title: 'Состояние экземпляра',
      description:
        'DID аккаунта, номер профиля, состояние связи с релеем (открыт ли сокет, ' +
        'сколько было попыток переподключения) и время работы процесса.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => reply(tools.status())
  );

  server.registerTool(
    'conversations_list',
    {
      title: 'Список переписок',
      description:
        'Переписки этого аккаунта с непрочитанными и превью последнего сообщения. ' +
        'Поле namesRead=failed означает, что имена контактов прочитать не удалось, ' +
        'и пустое имя не говорит об их отсутствии.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Сколько переписок вернуть (по умолчанию 50)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => reply(await tools.conversationsList({ limit }))
  );

  server.registerTool(
    'conversation_messages',
    {
      title: 'Сообщения переписки',
      description:
        'Страница сообщений, от свежих к старым. Следующая страница берётся с ' +
        'курсором из поля cursor — не по числу пропущенных: пока идёт чтение, ' +
        'приходят новые сообщения, и отсчёт по числу терял бы ровно столько же старых. ' +
        'text=null при unreadable=true означает, что строка есть, но ключ её не открыл.',
      inputSchema: {
        contact: contactArg,
        limit: z.number().int().min(1).max(200).optional().describe('Размер страницы (по умолчанию 50)'),
        before: cursorArg.nullish(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ contact, limit, before }) =>
      reply(await tools.conversationMessages({ contact, limit, before: before ?? null }))
  );

  server.registerTool(
    'contacts_list',
    {
      title: 'Список контактов',
      description:
        'Контакты этого аккаунта. implicit=true — запись завелась сама, при первой ' +
        'переписке, а не была добавлена.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => reply(await tools.contactsList())
  );

  server.registerTool(
    'contact_add',
    {
      title: 'Добавить контакт',
      description:
        'Завести контакт по идентификатору и вывести общий ключ переписки. ' +
        'Имя подрезается до 64 символов — в ответе то, что действительно легло в базу.',
      inputSchema: {
        id: contactArg,
        name: z.string().min(1).describe('Как называть этого человека'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, name }) => reply(await tools.contactAdd({ id, name }))
  );

  server.registerTool(
    'message_send',
    {
      title: 'Отправить сообщение',
      description:
        'Личное сообщение собеседнику. Отказ приходит с причиной: blocked ' +
        '(заблокирован), rate_limited (часовой лимит), no_session (нет общего ключа), ' +
        'no_route (конверт некуда отправить). Успех означает, что конверт принят ' +
        'релеем, а не что собеседник его прочитал.',
      inputSchema: {
        contact: contactArg,
        text: z.string().min(1).describe('Текст сообщения'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ contact, text }) => reply(await tools.messageSend({ contact, text }))
  );

  server.registerTool(
    'profile_get',
    {
      title: 'Карточка профиля',
      description:
        'Имя, «О себе», статус, местоимения и @имя. У каждого поля три состояния: ' +
        'value (значение), unset (не заполнено), unreadable (запись есть, прочитать не удалось).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => reply(await tools.profileGet())
  );

  server.registerTool(
    'profile_set',
    {
      title: 'Правка карточки профиля',
      description:
        'Меняет имя, «О себе», статус и местоимения и рассылает новую карточку контактам. ' +
        '@имя отсюда не меняется: оно занимается в общем реестре имён, и запись только ' +
        'в свою базу объявила бы занятым то, что не занято. Ссылки (сайт, X, GitHub) тоже ' +
        'не меняются: они пишутся вместе со своими доказательствами.',
      inputSchema: {
        displayName: z.string().optional().describe('Имя, до 40 символов'),
        bio: z.string().optional().describe('«О себе», до 200 символов'),
        status: z.string().optional().describe('Короткий статус'),
        pronouns: z.string().optional().describe('Местоимения'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => reply(await tools.profileSet(args))
  );

  server.registerTool(
    'privacy_get',
    {
      title: 'Настройки приватности',
      description:
        'Все решения о приватности этого аккаунта, с теми же тремя состояниями, ' +
        'что и у карточки. unreadable здесь особенно важен: осторожная сторона у ' +
        'каждого переключателя своя, и выбирает её спрашивающий.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => reply(await tools.privacyGet())
  );

  server.registerTool(
    'privacy_set',
    {
      title: 'Изменить настройку приватности',
      description:
        'privacy_last_seen_visibility и privacy_avatar_visibility принимают ' +
        'everybody | contacts | nobody, остальные — "true" | "false". Смена ' +
        '«когда я в сети» рассылается собеседникам: пока мы их не попросим, ' +
        'решение у них остаётся прежним.',
      inputSchema: {
        key: z.string().describe('Имя настройки, как в ответе privacy_get'),
        value: z.string().describe('Новое значение'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ key, value }) => reply(await tools.privacySet({ key, value }))
  );

  return server;
}
