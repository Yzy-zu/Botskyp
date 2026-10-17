import { z } from 'zod';
import { product } from '../../config/product.js';
import type { RefKind } from './safe-refs.js';
import { semanticTimeSchema } from '../modules/reminders/semantic-time.js';
import { recurrenceSchema } from '../modules/reminders/time.js';
import { clock, summarySchema } from '../modules/school/schemas.js';

const object = z.strictObject;
const empty = object({});
const text = z.string().trim().min(1).max(product.maxTextChars);
const short = z.string().trim().min(1).max(product.schoolSubjectChars);
const bool = z.boolean();
const integer = (max: number) => z.number().int().positive().max(max);
export const safeRefSchema = (kind: RefKind) => z.string().regex(new RegExp(`^${kind}_[0-9a-f-]{36}$`));
const ref = (kind: RefKind) => safeRefSchema(kind).describe('Referencia opaca entregada por el backend; nunca un ID real.');
const poll = { pollRef: ref('pollRef') };
const op = { opRef: ref('opRef') };
const task = { taskRef: ref('taskRef') };
const subject = z.union([ref('subjectRef'), short]).describe('Materia por referencia o nombre; el backend resuelve ambigüedades.');
const reminder = { body: text.optional(), time: semanticTimeSchema.optional(), recurrence: recurrenceSchema.optional() };
const destinations = z.array(ref('destinationRef')).min(1).max(product.bulkMaxTargets);
const message = { destinations, text: text.max(product.bulkTextChars) };
const lesson = object({ subject, weekday: integer(7), start: clock, end: clock });
const bet = z.number().int().min(product.gameMinBet).max(product.gameMaxBet).optional();

/** Separate model contracts. These schemas must never be passed directly to v1 handlers. */
export const modelArgsSchemas = {
  'core.ping': empty,
  'core.help': object({ topic: short.optional() }),
  'notes.create': object({ body: text }),
  'notes.list': object({ query: text.optional() }),
  'notes.edit': object({ noteRef: ref('noteRef'), body: text }),
  'notes.delete': object({ noteRef: ref('noteRef') }),
  'reminders.create': object(reminder),
  'reminders.list': empty,
  'reminders.edit': object({ reminderRef: ref('reminderRef'), ...reminder }),
  'reminders.cancel': object({ reminderRef: ref('reminderRef') }),
  'memory.remember': object({ body: text.max(product.memoryChars) }),
  'memory.list': empty,
  'memory.forget': object({ target: z.union([ref('memoryRef'), z.literal('all'), text.max(product.memoryChars)]) }),
  'web.search': object({ query: text.max(product.searchQueryChars) }),
  'polls.create': object({ question: text.max(product.pollQuestionChars), options: z.array(text.max(product.pollOptionChars)).min(2).max(product.pollMaxOptions), minutes: integer(product.pollMaxMinutes).optional() }),
  'polls.vote': object({ ...poll, option: z.union([integer(product.pollMaxOptions), text.max(product.pollOptionChars)]) }),
  'polls.results': object(poll),
  'polls.close': object(poll),
  'drive.cancel': object(op),
  'drive.search': object({ query: text.max(100) }),
  'drive.download': object({ driveRef: ref('driveRef') }),
  'drive.upload': object({ artifactRef: ref('artifactRef').optional() }),
  'drive.info': object({ driveRef: ref('driveRef') }),
  'drive.configure': object({ enabled: bool }),
  'drive.status': empty,
  'messaging.destinations': empty,
  'messaging.send': object(message),
  'bulk.broadcast': object(message),
  'bulk.nuclear': object({ count: z.number().int().min(product.nuclearMinMessages).max(product.nuclearMaxMessages).optional(), text: text.max(product.bulkTextChars) }),
  'bulk.confirm': empty,
  'bulk.cancel': object(op),
  'bulk.retry': object(op),
  'bulk.resume': object(op),
  'bulk.status': object({ opRef: ref('opRef').optional() }),
  'library.categories': empty,
  'packs.buy': object({ category: short.optional() }),
  'packs.orders': empty,
  'library.sync': object({ source: z.enum(['local', 'drive']) }),
  'library.sync_status': empty,
  'cooperacha.open': object({ goal: z.number().int().min(product.cooperachaMinGoal).max(product.cooperachaMaxGoal).optional(), category: short.optional() }),
  'cooperacha.contribute': object({ amount: integer(product.cooperachaMaxGoal) }),
  'cooperacha.status': empty,
  'cooperacha.cancel': empty,
  'library.rain': object({ enabled: bool, config: object({ schedule: summarySchema, count: integer(product.rainMaxItems), category: short.optional() }).optional() }),
  'media.process': object({
    artifactRef: z.union([ref('artifactRef'), z.literal('A_LAST')]).optional(),
    operation: z.enum(['download','mp3','ogg','wav','mp4','png','jpeg','webp','sticker','animated_sticker','bass','fast','slow','qr_create','qr_read','ocr','read','office_pdf','pdf_compress','pdf_crop','pdf_merge','pdf_images','images_pdf','transcribe','speak']),
    url: z.url().max(2048).regex(/^https?:\/\//u).optional(), text: z.string().trim().min(1).max(product.mediaTextChars).optional(),
    start: integer(product.mediaPdfPages).optional(), end: integer(product.mediaPdfPages).optional(), summary: bool.optional(),
  }),
  'media.search': object({ query: text.max(product.searchQueryChars), type: z.enum(['audio','video']) }),
  'media.collect': object({ operation: z.enum(['images_pdf', 'pdf_merge']) }),
  'media.status': empty,
  'minecraft.status': empty,
  'minecraft.players': empty,
  'minecraft.resources': empty,
  'minecraft.worlds': empty,
  'minecraft.addons': empty,
  'minecraft.logs': object({ lines: integer(product.minecraftLogLines).optional() }),
  'minecraft.config-get': empty,
  'minecraft.config-set': object({ key: z.enum(['difficulty','gamemode','max-players','pvp','allow-cheats']), value: z.enum(['1','2','3','4','5','6','7','8','9','10','12','16','20','peaceful','easy','normal','hard','survival','creative','adventure','true','false']) }),
  'minecraft.start': empty,
  'minecraft.stop': empty,
  'minecraft.restart': empty,
  'minecraft.backup': empty,
  'minecraft.console': object({ command: z.enum(['list','time query daytime','time set day','time set night','weather clear','weather rain']) }),
  'minecraft.operations': empty,
  'school.subjects': empty,
  'school.subject_save': object({ subjectRef: ref('subjectRef').optional(), name: short }),
  'school.subject_archive': object({ subjectRef: ref('subjectRef') }),
  'school.schedule': object({ weekday: integer(7).optional() }),
  'school.schedule_propose': object({ lessons: z.array(lesson).min(1).max(product.schoolLessonLimit) }),
  'school.schedule_import': object({ artifactRef: ref('artifactRef').optional() }),
  'school.schedule_commit': empty,
  'school.tasks': object({ subject: subject.optional() }),
  'school.task_create': object({ subject, title: text.max(product.schoolTaskChars), time: semanticTimeSchema.optional(), includeAttachment: bool.optional() }),
  'school.task_edit': object({ ...task, title: text.max(product.schoolTaskChars).optional(), time: semanticTimeSchema.nullable().optional() }),
  'school.task_delete': object(task),
  'school.task_attachment': object(task),
  'school.config': empty,
  'school.summary_configure': object({ enabled: bool, schedule: summarySchema.optional() }),
  'school.destination': object({ destinationRef: ref('destinationRef') }),
  'xp.balance': empty,
  'xp.daily': empty,
  'xp.happy': object({ minutes: integer(product.happyMaxMinutes).optional(), off: bool.optional() }),
  'games.blackjack': object({ bet, table: bool.optional() }),
  'games.roulette': object({ bet }),
  'games.join': empty,
  'games.play': object({ move: z.enum(['carta', 'plantarse', 'doblar']) }),
  'games.status': empty,
  'games.cancel': empty,
  'games.airdrop': empty,
  'games.claim': empty,
  'moderation.warns': empty,
  'moderation.change': object({ memberRef: z.union([ref('memberRef'), z.literal('SELF')]), remove: bool }),
  'moderation.config': object({ enabled: bool.optional(), minutes: integer(product.rouletteMaxPunishmentMinutes).optional() }),
  'control.emergency': empty,
  'control.reactivate': empty,
  'control.maintenance_on': empty,
  'control.maintenance_off': empty,
  'control.modules': object({ module: z.enum(['polls','media','messaging','drive','library','conversation','notes','reminders','memory','web','vision','minecraft','school','xp','games','moderation']).optional(), enabled: bool.optional() }),
  'diag.cuota': empty,
  'diag.errores': empty,
} as const satisfies Record<string, z.ZodType>;
export type BusinessToolName = keyof typeof modelArgsSchemas;
