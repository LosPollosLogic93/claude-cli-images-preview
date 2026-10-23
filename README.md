# claude-cli-images-preview

A [Claude Code](https://claude.com/claude-code) mod that shows the images you paste into the prompt as thumbnails in the terminal transcript, under the prompt that carried them.

Without it, a pasted image shows only as `[Image #N]` in the terminal. With it, the picture itself is drawn below that line. While an image waits in the prompt box, before you send it, a small preview of it shows in a framed band just above the box. Press **⛶** under any picture to see it large.

## Install

Mods need Claude Code **2.1.287** or later; this one was built and tested on 2.1.292. In a terminal session:

```
/plugin install pasted-images --marketplace LosPollosLogic93/claude-cli-images-preview
```

Answer `y` to add the marketplace and pick the user scope. Thumbnails appear for images you paste from then on.

## Requirements

- **A terminal with the kitty graphics protocol.** Claude Code draws pictures with it, and Ghostty and kitty support it. Where Claude Code decides the terminal cannot draw pictures, the mod adds nothing and the row keeps its `[Image #N]` text.
- **Inside a terminal multiplexer**, Claude Code cannot tell the outer terminal draws images and falls back to text. Set this before starting Claude Code:

  ```sh
  export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
  ```

  Only set it where the terminal really can draw images. For example, to set it only inside [herdr](https://herdr.dev) panes, add this to `~/.zshrc`:

  ```sh
  [[ -n $HERDR_ENV ]] && export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
  ```

## Tested on

| Terminal | Result |
|---|---|
| Ghostty inside herdr 0.9.5, macOS, Claude Code 2.1.292, with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` | Works |
| Ghostty inside herdr 0.7.5 | No pictures: that herdr does not pass kitty graphics through |

Nothing else has been tried yet, including plain Ghostty and kitty. Reports are welcome in the issues.

## How it works

- Claude Code saves each pasted image as a PNG, and stores an `[Image: source: …/N.png]` line beside the prompt in the conversation. The mod watches those lines as they are stored (`session.append`) and keeps where each image is in the session's `$.state`.
- If it has not seen that line, for instance after the mod reloads, it looks for the file in Claude Code's usual folder for the current session: `<tmp>/claude-<uid>/<project>/<session>/images/N.png`, under `/private/tmp` or `/tmp`.
- When the terminal draws a prompt you sent holding `[Image #N]` (`ui.render` on `UserMessage`), the mod draws the row as usual and adds an `Image` under it, sized to keep the picture's proportions, at most 60 columns by 16 rows. Messages from other sessions, agents, notifications and channels are left alone.

- While you type, it reads the `[Image #N]` placeholders in the prompt box (`prompt.edit`, and `$.prompt.read` four times a second, as pasting an image raises no edit) and draws small previews, at most 30 columns by 8 rows each, side by side in a framed band above the box headed "not sent yet" (`ui.render` on `AbovePrompt`), below anything another mod shows there. A spinner stands in for each picture while it loads; a paste can take a moment to reach disk, so the mod retries for about five seconds. The box itself cannot be drawn into by a mod. Sending the prompt clears the band.
- **⛶** under a thumbnail or preview opens the picture in a pane (`$.ui.open`), as large as the terminal allows. Esc or **Close** shuts it. A mod cannot make the picture itself clickable, so the button sits under it.

It only reads: the image files, the prompt box's text, and the folder listing it uses to find them. It runs no commands, makes no network calls and never changes what Claude reads.

## Limitations

- **It relies on undocumented Claude Code behaviour**: the `[Image: source: …]` lines and the folder images are saved in. A Claude Code update can quietly break it.
- **Earlier sessions:** images pasted before a `--resume` or `--fork-session` keep the text line only, because their files sit in the earlier session's folder.
- **Large files:** a PNG over 4 MiB gets no thumbnail, as a mod cannot read a file that size.
- **Typed placeholders:** a prompt in which you type `[Image #N]` yourself shows that session's image N, if there is one.
- PNG only, which is what Claude Code saves pastes as.
- The enlarged view is still drawn in terminal cells, so it is as sharp as the terminal's size allows, not the original resolution.

## Uninstall

```
/plugin uninstall pasted-images
```

## Develop

```sh
git clone https://github.com/LosPollosLogic93/claude-cli-images-preview
claude --plugin-dir ./claude-cli-images-preview
claude plugin validate ./claude-cli-images-preview
claude plugin test ./claude-cli-images-preview
```

## License

[MIT](LICENSE)
