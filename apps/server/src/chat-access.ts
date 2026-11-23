import { conversationMembers, conversations } from "@shipmate/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * True for conversations a person may read and write in: their own, and group chats they were
 * added to. For queries that select from `conversations`.
 */
export const chatOpenTo = (userId: string): SQL =>
  sql`(${conversations.userId} = ${userId} or exists (
    select 1 from ${conversationMembers} cm
    where cm.conversation_id = ${conversations.id} and cm.user_id = ${userId}
  ))`;

/** The same test for a conversation id held in another table's column. */
export const chatIdOpenTo = (conversationId: SQL | unknown, userId: string): SQL =>
  sql`exists (
    select 1 from ${conversations} c
    where c.id = ${conversationId} and (c.user_id = ${userId} or exists (
      select 1 from ${conversationMembers} cm
      where cm.conversation_id = c.id and cm.user_id = ${userId}
    ))
  )`;
