# Slack Co-Pilot

Transform your web Slack (`app.slack.com`) into an AI-powered workspace. This skill allows Koi to act as your personal Slack assistant—reading the channel you are in, summarizing long discussions, and drafting replies in your voice.

## Why use this instead of a standard Slack Bot?

Traditional Slack AI bots live on a server and act as a generic team assistant. Koi operates entirely differently:

- **It is YOUR Co-Pilot:** Koi lives in your browser, secured by your login. It sees exactly what you see, meaning it can read your private DMs and private channels without requiring complex IT permissions or bot invites.
- **Cross-Workspace Context:** A Slack bot only knows about Slack. Koi can read a Google Doc in one tab, check your Gmail in another, and then seamlessly draft a Slack update combining all that information.
- **Human-in-the-Loop Privacy:** Standard bots often automate things blindly in the background. Koi operates as a draft-and-review assistant, ensuring nothing is ever sent without your explicit visual approval.

## How it Behaves: The "Clean Slate" Model

To ensure perfect accuracy and prevent the AI from mixing up your conversations, this skill is designed with strict, predictable rules:

### 1. What You See is What It Sees

Koi is a passive assistant. It is tightly synced to your active Slack tab. If you want Koi to summarize a thread or draft a reply, simply navigate to that channel or DM and ask. It will instantly read the history of whatever is currently on your screen.

### 2. A Clean Slate for Every Channel

When you switch from one channel to another (e.g., clicking from `#engineering` to `#design`), **Koi resets its memory**.

- **Why?** This guarantees the AI will never accidentally hallucinate an engineering secret into a message meant for the design team. Every time you enter a new channel, you get a fresh, clean context perfectly focused on the current topic.

### 3. The "Snap-Back" Safety Guarantee

Drafting the perfect message takes time. If you ask Koi to write a long update and then navigate away to read another channel while you wait, Koi has your back.
When the draft is ready to post, Koi will **automatically snap your browser back to the original target channel** before asking for your final click of approval. You will always see exactly where the message is going with your own eyes before it is sent.

## Example Use Cases

Just open the Koi side panel while viewing Slack and try saying:

- _"Summarize this channel"_
- _"Should I post a response?"_

---

**Prerequisites:** You must use Slack via the web browser (`app.slack.com`), not the standalone desktop application.
