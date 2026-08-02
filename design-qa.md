# New conversation context flow

## Source visual truth

- User-provided reference screenshot: `99BB85AC-C9DD-40CB-A117-580C9F6E3EDE/1-Eingefügtes-Bild-1.jpg`
- Source pixels: 1280 × 629
- Intended state: new conversation with host, project, workspace strategy, and branch/worktree context selected before sending

## Implementation evidence

- Implementation screenshot: not captured
- Intended viewport: desktop reference width plus a narrow responsive viewport
- Density normalization: not applicable; the implementation capture was blocked
- The live app built successfully and the generated bundle contains the new `Work on` / context-flow copy; the old `Choose the work boundary before you send` copy is absent.

## Findings

- [P1] Browser-rendered comparison is blocked. The live UI evaluator could not navigate to the local app because browser navigation requires interactive approval in this session.
- Fonts and typography: not visually assessed without an implementation capture.
- Spacing and layout rhythm: not visually assessed without an implementation capture.
- Colors and visual tokens: not visually assessed without an implementation capture.
- Image quality and asset fidelity: no custom image assets are involved; icons use the existing icon component.
- Copy and content: deterministic bundle inspection confirms the old setup-card copy is gone and the new context-flow copy is present.

## Comparison history

1. Initial implementation comparison was not possible because the browser capture was blocked before a rendered implementation screenshot could be obtained.

## Primary interactions intended for verification

- Open the project selector from the project context row.
- Change the branch/worktree from the branch context row.
- Open workspace strategy and confirm only Aldunis-managed and provider-native choices are shown.
- Confirm Ask / Plan / Build remains available in the composer footer.
- Confirm no horizontal overflow at a narrow viewport and no console/network errors.

final result: blocked
