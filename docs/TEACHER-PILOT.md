# Teacher pilot

The pilot runs the complete app, authentication, dashboard and SQLite database on one VPS. The official free app is [sayboard.org](https://sayboard.org). Use [classroom.sayboard.org/teacher](https://classroom.sayboard.org/teacher) for the hosted pilot. Independent installations use their own hostname and `/teacher`.

## Try before signing in

Open `/teacher` and choose **Try a board**. It opens the real communication app with a separate example stored only in that browser tab. Try the tiles, use caregiver controls to edit the example, and export it if needed. This path does not read or replace the device's saved communication board, sign in, or link a classroom.

Choose **Save to teacher workspace** when the example is worth keeping. In the editor, **Save changes and continue to teacher workspace** explicitly saves the open example changes first. The example and save intent survive sign-in in the same tab, including a Google redirect. Nothing is uploaded until the teacher submits the classroom setup or chooses to save the example as a new learner board. Closing the tab can lose the example; export it before switching browsers or devices.

## First classroom

1. If **Create teacher workspace** is offered, choose a username and a password of 16 to 256 characters. Save the recovery kit privately, then choose **I saved my recovery kit**. You are already signed in. Hosts must opt into public signup. Existing accounts can sign in directly. Google sign-in and private invitations remain alternatives when offered. Invitations work once and expire after 48 hours. Learners need no email address or password.
2. On an empty workspace, enter a classroom name and learner alias such as `Learner A`, then choose **Create first board**. This creates both together and opens the board workspace. If you came from the example, the form explains that this saves it as a private draft on the server. Start with demonstration vocabulary. Returning teachers can create additional classrooms and add profiles separately.
3. Choose **Edit board**. The existing board editor supports tiles, categories, import and export. **Save classroom draft** stores the draft on the server.
4. Choose **Preview board** to try the actual communication view. Return to the dashboard and **Publish saved draft** when it is ready.
5. Choose **Connect learner device**, enter a device name, and create a pairing code. The code expires after 10 minutes and works once. Creating another code replaces the previous unused code for that profile.
6. On the intended device, open the address shown in the dashboard, ending in `/?linkClassroom=1`. It opens the existing connection screen and focuses the code field. The link contains no code, credentials or learner information and does not link the device by itself.
7. Under **Classroom board**, enter the pairing code and choose **Link classroom device**. Confirm the initial connection, then choose **Back to board**. This authorises the teacher's publications to replace this device's saved board automatically. The usual caregiver controls and **Backup and transfer** path remains available.

After pairing, leave the learner's device on its communication board. Edit and **Save classroom draft** from the teacher editor, then choose **Publish saved draft** in the dashboard. The learner's device checks for publications automatically while the app is open. No repeated load or save steps are required on that device.

The device waits until speech, typing and caregiver editing have finished before applying a complete, validated publication. It saves that version locally before reporting receipt. If a download or save fails, the previous saved board remains available and the device retries. A device that reconnects catches up with the latest publication.

The dashboard's **Connect a learner device** section refreshes device reports automatically. **Version N saved · Up to date** confirms that a recently connected device reported saving that publication. **Waiting for version N** means receipt has not been confirmed. **No recent contact** means the device has not contacted the server recently; it may be offline, suspended or closed. Publication alone does not confirm receipt.

## Recover or remove access

For a password account, choose **Recover workspace** on the sign-in page and enter your username, saved recovery code and a new password. Save the replacement recovery kit. The old code works only once, and recovery signs out other teacher sessions. Your classrooms, publications and linked learner devices remain in place. Recovery remains available when the host stops accepting new public accounts.

While signed in, choose **Recovery kit** and confirm your current password to replace a lost code. The previous code stops working. If you lose both the password and code, ask your host administrator for a reset. Google accounts use Google recovery; organiser accounts use the administrator reset procedure.

**More board options** contains export, refresh and copy controls. These do not need to be set up before trying or connecting the first board.

Open **Published versions** and select an older version in the dashboard to restore it into the draft, then preview and publish separately. Linked devices receive the new publication automatically at the next safe point.

Revoke a device in the dashboard to stop future downloads. A device can also disconnect itself. Neither action erases its working local board. Device credentials expire after 30 days; pair again when needed. Clearing browser cookies also requires pairing again.

Deleting a profile or classroom removes its drafts, publications and device links from the live database. It does not erase exported files or boards already saved on devices. Encrypted backups retain deleted data until their retention period ends. Operator commands can reset passwords or delete an adult account and its associated data.

## Invite teachers

An operator enables invitation controls for the pilot organiser's account. After signing in, that organiser sees **Invite a teacher** below the classroom list. Ordinary teacher accounts cannot access these controls or create further invitations.

Choose a unique teacher username, then create a private link or select email delivery when configured. Send an email only to the intended adult. Teachers choose their own passwords; the organiser does not need to know them. A new link replaces an older unused link for the same username. **Cancel pending link** revokes an unused invitation without deleting an existing account.

For a password reset, choose **Existing teacher password reset** and enter the existing username. That link expires after one hour. Saving the new password invalidates the old password and signs out existing teacher sessions. The reset also revokes any recovery code. This remains available for teachers who cannot use their recovery kit.

Email delivery uses optional standard SMTP. The app reports whether the email service accepted the message, which is not a guarantee of inbox placement. If sending fails, the organiser can still share the private link securely. Invitation emails include the username and setup link, never learner boards or spoken messages.

## Pilot limits

One adult owns each classroom. Multiple teachers sharing a school workspace, delegated classroom roles and billing are not implemented. Public signup is an explicit hosted SQLite option with a configurable account limit. Classroom hosting and invitations currently use SQLite; the optional PostgreSQL adapter supports personal backups only.

Use an individual adult account rather than a shared password. Store only the vocabulary and aliases needed for the pilot. There is no analytics or collection of what a learner says. Classroom drafts and publications intentionally live on the server; local communication boards stay on their device unless explicitly saved or exported.

Export the working board before switching website addresses, browsers or devices. The retired `sayboard.vercel.app` app entry redirects to `sayboard.org`; its `/move-board.html` recovery page remains available to export boards stored under the old address. Those boards do not automatically appear at `sayboard.org` or the classroom hostname. Offline startup and actual speech still need checking on the teacher's intended hardware. Keep the person's established communication tools available.

## Operator checks

Before using real classroom data, confirm the school's permission and data-handling arrangements, give the teacher their own account, and verify speech on the intended device. Test creation, publication, pairing, update, rollback and revocation with demonstration boards. Verify an encrypted backup can be decrypted and restored. Keep the recovery key and a recent encrypted copy off the VPS.

The automated suite executes the complete browser workflow in Chromium and WebKit, checks cross-account isolation and device scope against the actual SQLite API, and tests server restart and snapshot restore. See [SELF-HOSTING.md](SELF-HOSTING.md) for deployment and maintenance.
