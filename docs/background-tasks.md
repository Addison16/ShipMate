# Background tasks

The main agent (the Captain, or whatever you named it) does not do every job itself. It hands
jobs to the other agents and stays free to talk with you. Each job it hands over is a **task**
that runs in the background.

## What you see

- **A card in the chat** for each task: who has it, what was asked, and how it stands
  (Waiting to start, Working, Needs you, Done, Could not finish, Stopped).
- **You can keep chatting.** The Captain answers you while tasks run. Ask "how is it going?"
  and it knows which tasks are still open.
- **The result lands in the chat** as the agent's own reply, folded when it is long. The Captain
  then checks it and tells you the outcome in a line or two. If something is missing it sends
  the task back with notes, up to 3 times, and then asks you how to go on.
- **Questions come to you.** When an agent on a task needs your decision or an approval, the
  card shows in the main chat, so you do not have to open the task.
- **A line above the message box** ("2 tasks working · 1 needs you") opens the list of the
  chat's tasks. The chat list marks chats that have work going on.

Tap **Open** on a card to see the task's own chat: watch the agent work, write to it yourself,
or press **Stop**.

## How many run at once

Settings → General → **Tasks at once** (default 3, up to 8). More tasks than that wait their
turn. Pick 1 or 2 when one local model serves every agent, since it can only answer one at a
time anyway. Tasks in the same project (the Shipyard) always run one after another, so two
agents never edit the same files at once. A task that is waiting for your answer does not hold
up the others.

## Where it works

- **The web app**: everything above.
- **Discord, Telegram and Slack**: the hand-over, the agent's result and the Captain's summary
  arrive as messages, and questions arrive as the usual buttons.
- **Routines and other apps**: nobody is there to read a later message, so the Captain waits
  for the agent and gives one complete answer, as before.

## Limits that keep small models out of trouble

- At most 12 open tasks per chat.
- Handing over the same job twice does not start it twice. The same job is not started again
  until you write again.
- After a result comes in, the Captain can start at most 8 more tasks on its own before it has
  to report to you.
- A task can be sent back 3 times.
- Deleting a chat stops its tasks and deletes their chats. A private chat's tasks are private
  too. If Shipmate restarts while tasks run, they are marked "Could not finish" with a note,
  and you can ask for them again.
