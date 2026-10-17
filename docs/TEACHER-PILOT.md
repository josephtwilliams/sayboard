# Teacher pilot

The pilot runs the complete app, authentication, dashboard and SQLite database on one VPS. The official free app is [sayboard.org](https://sayboard.org). Use [classroom.sayboard.org/teacher](https://classroom.sayboard.org/teacher) for the hosted pilot. Independent installations use their own hostname and `/teacher`.

## First classroom

1. Open your organiser's private invitation, choose a password of at least 16 characters, and sign in with the username shown. Invitations work once and expire after 48 hours. Existing operator-created accounts can sign in directly. There is no public signup, student email or student password.
2. Create a classroom, then add a profile using an alias such as `Learner A`. Begin with demonstration vocabulary.
3. Choose **Edit board**. The existing board editor supports tiles, categories, import and export. **Save classroom draft** stores the draft on the server.
4. Choose **Preview board** to try the actual communication view. Return to the dashboard and **Publish saved draft** when it is ready.
5. Enter a device name and create a pairing code. The code expires after 10 minutes and works once. Creating another code replaces the previous unused code for that profile.
6. On the intended device, open the same classroom hostname. Choose **Caregiver controls**, then **Edit board and settings**, and expand **Backup and transfer**.
7. Under **Classroom board**, enter the pairing code and choose **Link classroom device**. Confirm the initial connection. This authorises the teacher's publications to replace this device's saved board automatically.

After pairing, leave the learner's device on its communication board. Edit and **Save classroom draft** from the teacher editor, then choose **Publish saved draft** in the dashboard. The learner's device checks for publications automatically while the app is open. No repeated load or save steps are required on that device.

The device waits until speech, typing and caregiver editing have finished before applying a complete, validated publication. It saves that version locally before reporting receipt. If a download or save fails, the previous saved board remains available and the device retries. A device that reconnects catches up with the latest publication.

The dashboard's **Classroom devices** section refreshes device reports automatically. **Version N saved · Up to date** confirms that a recently connected device reported saving that publication. **Waiting for version N** means receipt has not been confirmed. **No recent contact** means the device has not contacted the server recently; it may be offline, suspended or closed. Publication alone does not confirm receipt.

## Recover or remove access

Select an older version in the dashboard to restore it into the draft, then preview and publish separately. Linked devices receive the new publication automatically at the next safe point.

Revoke a device in the dashboard to stop future downloads. A device can also disconnect itself. Neither action erases its working local board. Device credentials expire after 30 days; pair again when needed. Clearing browser cookies also requires pairing again.

Deleting a profile or classroom removes its drafts, publications and device links from the live database. It does not erase exported files or boards already saved on devices. Encrypted backups retain deleted data until their retention period ends. Operator commands can reset passwords or delete an adult account and its associated data.

## Invite teachers

An operator enables invitation controls for the pilot organiser's account. After signing in, that organiser sees **Invite a teacher** below the classroom list. Ordinary teacher accounts cannot access these controls or create further invitations.

Choose a unique teacher username, then create a private link or select email delivery when configured. Send an email only to the intended adult. Teachers choose their own passwords; the organiser does not need to know them. A new link replaces an older unused link for the same username. **Cancel pending link** revokes an unused invitation without deleting an existing account.

For a password reset, choose **Existing teacher password reset** and enter the existing username. That link expires after one hour. Saving the new password invalidates the old password and signs out existing teacher sessions. Password recovery during the pilot is organiser-assisted; there is no public recovery form or automatic signup.

Email delivery uses optional standard SMTP. The app reports whether the email service accepted the message, which is not a guarantee of inbox placement. If sending fails, the organiser can still share the private link securely. Invitation emails include the username and setup link, never learner boards or spoken messages.

## Pilot limits

One adult owns each classroom. Multiple teachers sharing a school workspace, delegated classroom roles, self-service password recovery and billing are not implemented. Classroom hosting and invitations currently use SQLite; the optional PostgreSQL adapter supports personal backups only.

Use an individual adult account rather than a shared password. Store only the vocabulary and aliases needed for the pilot. There is no analytics or collection of what a learner says. Classroom drafts and publications intentionally live on the server; local communication boards stay on their device unless explicitly saved or exported.

Export the working board before switching website addresses, browsers or devices. The retired `sayboard.vercel.app` app entry redirects to `sayboard.org`; its `/move-board.html` recovery page remains available to export boards stored under the old address. Those boards do not automatically appear at `sayboard.org` or the classroom hostname. Offline startup and actual speech still need checking on the teacher's intended hardware. Keep the person's established communication tools available.

## Operator checks

Before using real classroom data, confirm the school's permission and data-handling arrangements, give the teacher their own account, and verify speech on the intended device. Test creation, publication, pairing, update, rollback and revocation with demonstration boards. Verify an encrypted backup can be decrypted and restored. Keep the recovery key and a recent encrypted copy off the VPS.

The automated suite executes the complete browser workflow in Chromium and WebKit, checks cross-account isolation and device scope against the actual SQLite API, and tests server restart and snapshot restore. See [SELF-HOSTING.md](SELF-HOSTING.md) for deployment and maintenance.
