# 孤儿清单备份 · create-bits-n-tracks.pw.toml

| 项 | 值 |
|---|---|
| 来源路径 | `minecraft/mods/.index/create-bits-n-tracks.pw.toml` |
| 备份时间 | 2026-10-04 15:37（备份时点） |
| 字节数 | 640 |
| md5 | `9874d0664123168002dbf0384c71f6c7` |
| 来源文件的 mtime | 2026-10-03 20:13（与 jar 被改名同一时刻） |
| 本备份的用途 | 原文留档：若日后决定「删清单」，可据此一键复原 |

## 背景

该清单声明 `bits_n_tracks-1.0.3.1-release.jar`（Modrinth 项目 `wYkiNwv2` / 版本 `CbqV5KMv`），
而磁盘上对应的 jar 已被改名为 `minecraft/mods/bits_n_tracks-1.0.3.1-release.jar.disabled`（261727 B，禁用）。
清单与磁盘不一致 ⇒ **任何人 clone 后跑「下载 Mod」都会把它重新下载并启用**，静默推翻禁用决定。

**这份备份放在 `server-pack/` 下（不在 `minecraft/mods/.index/`），因此 Prism / packwiz 不会读取它**，
不会造成上述复活风险，只是留一张原文底片。详见 `../../PREFLIGHT-CLEANUP.md` §2。

## 复原方法（仅在决定「恢复启用」时使用）

```bash
cp server-pack/ops/orphan-manifest-backup/create-bits-n-tracks.pw.toml \
   minecraft/mods/.index/create-bits-n-tracks.pw.toml
md5sum minecraft/mods/.index/create-bits-n-tracks.pw.toml   # 应等于 9874d0664123168002dbf0384c71f6c7
```
（若同时要把 mod 恢复启用，还需把 `.jar.disabled` 改回 `.jar`；那属于内容策略决定，不在本备份职责内。）
