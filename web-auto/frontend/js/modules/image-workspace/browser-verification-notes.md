# Image Workspace Browser Verification Notes

Use this file to record manual browser checks after each refactoring phase. Do not commit passwords or session tokens.

## Login

- User: `admin`
- Password source: current task context or local `WEB_AUTO_E2E_PASSWORD`

## Checklist

```text
Phase:
Commit:
URL:
Browser:
Project:

Checks:
- [ ] Login succeeds.
- [ ] Project list opens.
- [ ] Image project opens.
- [ ] Image list, pagination, and filters render.
- [ ] Current image tiles and annotations load.
- [ ] Manual bbox creation saves.
- [ ] Manual polygon creation saves.
- [ ] Annotation class edit saves.
- [ ] Selected annotation delete saves.
- [ ] Single image delete removes image and annotation file.
- [ ] Single-image inference still starts.
- [ ] Batch inference controls still render.
- [ ] Smart filter modal opens.
- [ ] Export modal opens.

Failures:

Notes:
```
