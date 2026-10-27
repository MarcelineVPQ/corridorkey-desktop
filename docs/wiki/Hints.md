# Hints

A hint is a rough matte you give CorridorKey to say what the subject is. The model then pulls the fine matte (hair,
motion blur, soft edges) itself. You don't need one: without a hint the model decides on its own. But when a shot is
ambiguous (props, several people, green on green), a hint is the most direct way to steer it.

## The three modes

Set per clip, in the **Hint** section:

| Mode | What you give it | When to use it |
| --- | --- | --- |
| **No hint** | nothing | The model picks the subject. Fastest to set up. |
| **First-frame matte** | one image: a matte of the first frame | Usually the best practical choice. |
| **Hint video** | a matte for every frame: a video or a frame folder | When you already have a roto pass, a garbage matte or an automatic mask for the whole shot. |

A matte is **white for the subject, black for the background**. A first-frame matte (**Matte image**) can be a PNG,
JPEG or EXR; a PNG with an alpha channel is read by its alpha. A hint video must have at least as many frames as the clip.

## Hint trust

**Hint trust** tells the model how far to believe your matte:

| Your matte | Hint trust |
| --- | --- |
| An artist's matte | 0.95 (the default) |
| A rough automatic one | about 0.75 |
| A loose one | 0.5 or less |

**Carry** (on by default) carries the model's matte from one temporal window to the next.

## Companion files: let the app find the hint

When you add a clip, the app looks next to it for a matte named after it, and if it finds one, selects it ("Found a
hint next to the clip and selected it."). The names are the original CorridorKey launcher's, so a folder prepared
for it works unchanged. Case doesn't matter.

| Clip | First-frame matte | Hint video |
| --- | --- | --- |
| `shot01.mp4` | `shot01FrameHint.png` (preferred), or `shot01_AlphaHint.png` | `shot01_AlphaHint.mp4` (any of the video types the app reads) |
| `shot01/Input/` (a shot folder of frames) | | `shot01/AlphaHint/` (a folder of matte frames) |

A first-frame matte can be `.png`, `.jpg`, `.jpeg` or `.exr`. The separator before `AlphaHint` can be `_`, `-`, a
space or nothing. If both a hint video and a first-frame matte are there, the hint video is selected. Hint files are
never added to the queue as clips of their own.

You can always change the mode or pick another file in the clip's **Hint** section. A clip set to a hint mode
without its file waits, with a note: "Choose the first-frame matte, or pick No hint".

## Making a hint with DaVinci Resolve's Magic Mask

Any tool that can render a black-and-white matte of your subject works. DaVinci Resolve's **Magic Mask** is a quick
way to get one:

1. Use Magic Mask on the shot to isolate the subject.
2. Render the mask itself as the output, white for the subject and black for the background, at the clip's size.
   - For a **first-frame matte**, export the first frame as a still (PNG).
   - For a **hint video**, render the whole shot.
3. Save it next to the clip with a companion name (above), or pick it by hand in the clip's **Hint** section.
4. An automatic mask is usually rough at the edges, so set **Hint trust** to about 0.75, the in-app guide's value for
   a rough automatic matte (above), and raise it if your mask is clean.

A step-by-step Resolve round trip (plate and Magic Mask hint out of Resolve, results back in with the alpha intact,
with exact settings and screenshots) is planned: [backlog row 40](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/BACKLOG.md).
Making hints inside the app itself is an idea on the backlog too (row 4).

## How good does the hint need to be?

It's a guide, not the final matte: the matte you get is the model's. What matters is that the hint says clearly
which parts are the subject, and that **Hint trust** matches how good it is: high for a careful artist's matte, lower
for a rough or loose one, so the model leans on it only as far as it deserves.
