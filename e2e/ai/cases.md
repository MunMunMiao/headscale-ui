# AI E2E cases

Run against the seeded playground in `README.md` unless a case says otherwise. "Verify" means check
Headscale through the API or logs, not only the UI. Each case requires the seeded baseline plus its
stated prerequisites; create any required keys, policy entries, or pending registrations first.
Restore owned changes afterwards, or reset the disposable playground before the next case.

This catalogue contains reusable steps and acceptance criteria only. Record the environment,
outcomes, evidence, failures, and cleanup in a separate run directory under
`.claude/ai-e2e/runs/<run-id>/`, never in this file or elsewhere under `e2e/ai/`.

## Profiles and login (LOGIN)

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| LOGIN-01 | Empty state | Open `/` with no profiles | Redirect to `/login`; "Add server" card is centered |
| LOGIN-02 | Add-profile form | Open "Add server" | Labeled fields for name, URL, API key, password, confirm; remember option explained |
| LOGIN-03 | Cross-origin server in pane | Server URL `http://127.0.0.1:18080` in the browser pane | Connects when the browser supports cross-origin SharedWorker fetches; if blocked, record the environment limitation separately and verify the same-origin URL |
| LOGIN-04 | Save and unlock | Fill all fields, "Save and unlock" | Lands on `/home` with data |
| LOGIN-05 | Wrong password on unlock | Locked card, wrong password | One inline error, field focus and aria-invalid; session unchanged |
| LOGIN-06 | Unlock | Correct password | Redirects to `redirect` param |
| LOGIN-07 | Reload single tab | Full page load with no other tab open | Requires the password when no unlocked SharedWorker session survives |

## Shell, preferences, server settings (SHELL)

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| SHELL-01 | Navigation | Click each top tab | Correct page, active state |
| SHELL-02 | Language | Profile menu > Language > each locale; Arabic | UI translates; `dir=rtl` for Arabic |
| SHELL-03 | Theme | Light, dark, system | Applies immediately |
| SHELL-04 | Overview | Open `/home`; click stat cards and recent devices | Data matches Headscale; cards link to the corresponding pages |
| SHELL-05 | Refresh | "Refresh data" | Reloads snapshot and shows "Data updated" status |
| SHELL-06 | API key create | Server settings > API keys > Create | New key shown once with copy, listed |
| SHELL-07 | API key expire/delete | Row menu on a non-session key | Confirm, status updates, verify in Headscale |
| SHELL-08 | Session key guard | Row menu on the current session's key | Requires acknowledgement |
| SHELL-09 | Backfill IPs | Maintenance > Backfill > acknowledge | Result shown |
| SHELL-10 | Change password, wrong current | Encryption > Change password with wrong current | Inline error, fields kept |
| SHELL-11 | Change password | Correct current password | Success; session locks |
| SHELL-12 | Settings dialog layout | Switch tabs | Stable position |

## Devices (DEV)

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| DEV-01 | Table at 789px | Open `/devices` | Table or cards fit the viewport; every row has a visible actions button |
| DEV-02 | Search | Name, user, IP, no match | Filters; empty state; clear button |
| DEV-03 | Status filters | all/online/offline/expired/routes/tagged | Correct subsets |
| DEV-04 | Export CSV | Intercept download | CSV opens correctly in Excel, columns match table |
| DEV-05 | Details | Click device name | Localized details |
| DEV-06 | View routes | Row menu > View routes | Opens `/routes` focused on device |
| DEV-07 | Rename invalid | `Bad Name!`; submit | Client-side DNS-label validation blocks the request and shows a localized inline rule |
| DEV-08 | Rename empty | Clear name | Save disabled |
| DEV-09 | Rename | `alice-laptop`; verify | Renamed |
| DEV-10 | Tags without owner | `tag:test` with no tagOwners | Explains tagOwners requirement |
| DEV-11 | Tags | `tag:shared` with tagOwners; verify | Warns that tagging removes the named user owner and cannot be fully undone; requires acknowledgement before tagging |
| DEV-12 | Expire | Row menu > Expire | Status "expired" |
| DEV-13 | Disable expiry | Expired device > Disable expiry | Back online, expiry "never" |
| DEV-14 | Remove | Row menu > Remove > confirm; verify | Removed |
| DEV-15 | Wizard: client | Add device > Client device | Safe defaults for personal devices; ephemeral off |
| DEV-16 | Wizard: expiry input | Clear field, type 30 | 30 days |
| DEV-17 | Wizard: generate | Step 3 > Generate | Key and command for the chosen options |
| DEV-18 | Wizard: list refresh | Register a device with the command, Finish | New device appears |
| DEV-19 | Wizard: server preset | Linux server | Defaults explained |
| DEV-20 | Pending registration | `tailscale up` without key; paste URL; user bob | Device registered |
| DEV-21 | SSH check mismatch | Type SSH check, paste a device link | Rejected before sending |
| DEV-22 | Wizard at 510px height | Any step | Footer reachable |

## Users (USER)

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| USER-01 | List | Open `/members` | Users, devices and auth source shown; no invented role column or filter |
| USER-02 | Create empty | Submit without name | Blocked with message |
| USER-03 | Create invalid name | `Bad User!`; verify | Rejected or warned (unusable as policy principal) |
| USER-04 | Create duplicate | `alice` | Localized duplicate message |
| USER-05 | Create with bad email | Email `not-an-email`; verify | Rejected |
| USER-06 | Details | Click user | Complete, consistent details |
| USER-07 | View devices | Row menu > View devices | Devices of that user only |
| USER-08 | Rename | Create node-less `ai-test-user`, add a policy reference, rename to `ai-test-renamed`; verify API and policy, then delete the temporary user and reference | User ID stays stable; username-based policy references follow the rename, while email-based references stay valid |
| USER-09 | Groups/tags empty | Join group / Grant tag with no policy entries | Explains, Apply disabled |
| USER-10 | Create auth key | Row menu > Create auth key | Owner preselected; safe defaults |
| USER-11 | Owner-less key | Owner "none", no tags | Inline validation, focus tags |
| USER-12 | Join group | Check `group:team`, Apply; verify policy | Only this change written; principal derived from email when set |
| USER-13 | Delete with cleanup | Delete user in a group; verify | User and references removed (user deleted first) |
| USER-14 | Delete user with devices | Delete `bob` | Refused, policy untouched |

## Auth keys (KEY)

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| KEY-01 | Filters | all/ready/used/expired/tagged | Correct subsets |
| KEY-02 | Search | Tag, user, prefix, no match | Filters, empty state |
| KEY-03 | Expire | Row menu > Expire; verify | Status "expired" |
| KEY-04 | Delete | Row menu > Delete; verify | Removed |
| KEY-05 | Login server across pages | Set a custom login-server URL in the auth-key page, copy its command, then open the device wizard; also try blank, FTP and malformed URLs | Both pages use the same session-scoped login server; invalid URLs hide the command, not the one-time secret; verify the copied command and record separately if OS clipboard readback is unavailable |

## Routes (ROUTE)

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| ROUTE-01 | Approve subnet | Approve `10.42.0.0/16`; verify | Approved, moves out of pending; full list labelled "Advertised routes", pending list contains only pending routes |
| ROUTE-02 | Approve exit | Approve `0.0.0.0/0`; verify | Exit pair shown as one "Exit node" with one approve control; dialog states both exit routes are approved |
| ROUTE-03 | Revoke exit | Revoke `::/0` | Pair revoked, explained |
| ROUTE-04 | Approve all | Approve all | All approved, button disabled |

## Access control (ACL)

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| ACL-01 | No policy | Open `/access` with no policy | Allow-all warning and templates; Save disabled without changes |
| ACL-02 | Check policy | "Check policy" | Dry run, nothing saved |
| ACL-03 | Template replaces allow-all | Apply "Small team sharing" | Confirmation lists the removed allow-all rule and warns that untagged devices lose access |
| ACL-04 | Restore open access | After a template is saved | "Add rule" is available in the IP rules section to restore an allow-all rule |
| ACL-05 | Team members | Add alice, bob | Shown in draft |
| ACL-06 | Dialog close guard | Edit a team/tag and click "Done"; reopen and edit again, then dismiss with Esc or X; exercise Cancel, Discard these changes, and Save and close | Done keeps the page draft without a prompt; only dismissing opens the guard, whose choices match their effects |
| ACL-07 | Team validation | `Ops Team!`, duplicate `team` | Inline rules |
| ACL-08 | Custom port | Type `8080`, Tab | Added to access |
| ACL-09 | Rename team | `team` to `devs`, save; verify | groups, tagOwners, acls updated |
| ACL-10 | Delete tag in use | Delete `shared` while a device carries it | Warns about tagged devices |
| ACL-11 | Members lock while Access dirty | Make a page-level Access edit (delete an IP rule), open Members row menu | Join group / Grant tag disabled |
| ACL-12 | Delete IP rule | Delete `* → *` in the advanced section | Confirmation; "Add rule" remains available and the rule can be re-added |
| ACL-13 | Discard page draft | Delete an IP rule as in ACL-12, then discard the page draft | Discard/undo control restores the saved policy |

## Multi-tab session (TAB)

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| TAB-01 | Join | Tab A unlocked on devices; open tab B on members | B enters without password |
| TAB-02 | Shared data | Rename in B; open the page in A via app link | A shows the new name |
| TAB-03 | Logout | A on `/devices`, B on `/members`; logout in B | A locks and both pages preserve their own return path |
| TAB-04 | Unlock in peer | After peer logout, unlock in B | B returns to its page; A follows without another password prompt |
| TAB-05 | Draft on lock | Leave an unsaved Access policy edit in A; logout and unlock in B | Old draft cannot be submitted; A explains that its Access edits were discarded before continuing |
| TAB-06 | Peer closure and recording isolation | Close B, select A and compare timeOrigin; write a run note under `.claude/ai-e2e/runs/<run-id>/`, then compare again | Closing B keeps A unlocked; recording evidence does not reload the tested page or change files under `e2e/ai/` |
