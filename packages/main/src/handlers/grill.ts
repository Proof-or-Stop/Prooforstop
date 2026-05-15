import type { HandlerContext } from './context.js';
import type { GrillData, GrillQuestion, GrillQuestionStatus, GrillSession } from '../core/types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function nextSessionId(data: GrillData): string {
  return `GRILL-${String(data.sessions.length + 1).padStart(3, '0')}`;
}

function nextQuestionId(session: GrillSession): string {
  return `GQ-${String(session.questions.length + 1).padStart(3, '0')}`;
}

function emptyGrill(storyId: string): GrillData {
  return { storyId, updatedAt: nowIso(), sessions: [] };
}

function unresolvedQuestions(session: GrillSession): GrillQuestion[] {
  return session.questions.filter(question => question.status === 'unresolved');
}

function getSession(data: GrillData, sessionId: string): GrillSession {
  const session = data.sessions.find(entry => entry.sessionId === sessionId);
  if (!session) throw new Error(`grill session not found: ${sessionId}`);
  return session;
}

function getActiveSession(data: GrillData): GrillSession | null {
  const openSessions = data.sessions.filter(session => session.status === 'open');
  return openSessions[openSessions.length - 1] || null;
}

function requireStoryId(storyId: string | undefined): string {
  if (!storyId || storyId.trim().length === 0) throw new Error('storyId is required');
  return storyId.trim();
}

export function createGrillHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    grill_start(args: { storyId: string; topic?: string }): object {
      const storyId = requireStoryId(args.storyId);
      store.readStory(storyId);

      const data = store.readGrill(storyId) || emptyGrill(storyId);
      const session: GrillSession = {
        sessionId: nextSessionId(data),
        topic: trimOptional(args.topic),
        status: 'open',
        startedAt: nowIso(),
        questions: [],
      };
      const updated: GrillData = {
        storyId,
        updatedAt: session.startedAt,
        sessions: [...data.sessions, session],
      };
      store.writeGrill(storyId, updated);

      return {
        storyId,
        sessionId: session.sessionId,
        status: session.status,
        artifact: 'grill.json',
        message: `Grill session started: ${session.sessionId}`,
      };
    },

    grill_record(args: {
      storyId: string;
      sessionId?: string;
      question: string;
      answer?: string;
      status?: GrillQuestionStatus;
      source?: string;
    }): object {
      const storyId = requireStoryId(args.storyId);
      store.readStory(storyId);
      const questionText = args.question?.trim();
      if (!questionText) throw new Error('question is required');

      const data = store.readGrill(storyId) || emptyGrill(storyId);
      const session = args.sessionId ? getSession(data, args.sessionId) : getActiveSession(data);
      if (!session) {
        throw new Error('No active grill session; pass sessionId or run grill_start first');
      }
      if (session.status !== 'open') {
        throw new Error(`grill session ${session.sessionId} is ${session.status}; start a new session to record more questions`);
      }

      const answer = trimOptional(args.answer);
      const status = args.status || (answer ? 'answered' : 'unresolved');
      if (status === 'answered' && !answer) {
        throw new Error('answer is required when status is answered');
      }
      const recordedAt = nowIso();
      const source = trimOptional(args.source);
      const entry: GrillQuestion = {
        id: nextQuestionId(session),
        question: questionText,
        ...(answer ? { answer } : {}),
        status,
        recordedAt,
        ...(status === 'answered' ? { resolvedAt: recordedAt } : {}),
        ...(source ? { source } : {}),
      };
      session.questions.push(entry);
      data.updatedAt = recordedAt;
      store.writeGrill(storyId, data);

      return {
        storyId,
        sessionId: session.sessionId,
        questionId: entry.id,
        status: entry.status,
        artifact: 'grill.json',
        message: `Recorded grill question: ${entry.id}`,
      };
    },

    grill_close(args: { storyId: string; sessionId?: string; note?: string; closedBy?: string }): object {
      const storyId = requireStoryId(args.storyId);
      store.readStory(storyId);
      const data = store.readGrill(storyId) || emptyGrill(storyId);
      const session = args.sessionId ? getSession(data, args.sessionId) : getActiveSession(data);
      if (!session) {
        throw new Error('No active grill session; pass sessionId or run grill_start first');
      }
      if (session.status === 'closed') {
        const remaining = unresolvedQuestions(session).map(question => question.question);
        return {
          storyId,
          sessionId: session.sessionId,
          status: session.status,
          remainingUnknowns: remaining,
          message: `Grill session already closed: ${session.sessionId}`,
        };
      }

      const closedAt = nowIso();
      session.status = 'closed';
      session.closedAt = closedAt;
      session.closedBy = trimOptional(args.closedBy);
      session.closeNote = trimOptional(args.note);
      data.updatedAt = closedAt;
      store.writeGrill(storyId, data);

      return {
        storyId,
        sessionId: session.sessionId,
        status: session.status,
        remainingUnknowns: unresolvedQuestions(session).map(question => question.question),
        artifact: 'grill.json',
        message: `Grill session closed: ${session.sessionId}`,
      };
    },

    grill_get(args: { storyId: string; sessionId?: string }): GrillData | GrillSession | { _empty: true } {
      const storyId = requireStoryId(args.storyId);
      store.readStory(storyId);
      const data = store.readGrill(storyId);
      if (!data) return { _empty: true };
      if (args.sessionId) return getSession(data, args.sessionId);
      return data;
    },
  };
}
