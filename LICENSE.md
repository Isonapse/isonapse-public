# ISONAPSE PUBLIC BETA
## END USER LICENSE AGREEMENT

**Isonapse Agent Hook and Isonapse Community Edition**

**Version 1.1**  
**Effective:** 10 November 2026

**Changes in version 1.1.** This version replaces version 1.0 of 11 July 2026, titled "Isonapse Agent Hook Public Beta End User License Agreement", which did not cover Community Edition. Version 1.1 extends the same terms to the Community Edition public beta. It adds: the Community Edition software and its container images (introduction); use by your own team (Sections 2 and 3); the rule that configuring the Software through its documented settings is not a modification (Section 2); self-hosting responsibilities and the absence of a service level (Section 4); Community Edition's data, credentials, network connections, and third-party components, and which binaries the dependency manifest covers (Section 5); and the data you may keep after termination (Section 9). It also records that it replaces version 1.0 (Section 10) and where to send requests under Section 5 (Section 11). The other terms, including the evaluation-only licence, the warranty disclaimer, the liability limit, and the governing law, are unchanged.

This End User License Agreement ("Agreement") is between you, either as an individual or on behalf of a legal entity ("you"), and Isonapse GmbH, Zug, Switzerland ("Isonapse").

This Agreement governs your use of the following Isonapse software, together with related binaries, container images, installation materials, documentation, and updates distributed by Isonapse through official channels (collectively, the "Software"):

- **Isonapse Agent Hook**: the software that governs AI agents on your machine, including its command-line tool, hook client, local control plane, and host adapters; and
- **Isonapse Community Edition**: the self-hosted server, dashboard, and control plane container images, and the commands of the Isonapse command-line tool that install, start, and manage them, such as `isonapse setup`, `isonapse server`, and `isonapse dashboard`.

This Agreement does not apply to Isonapse Enterprise Edition or other Isonapse products, which are subject to separate terms.

**BY DOWNLOADING, INSTALLING, OR USING THE SOFTWARE, YOU AGREE TO THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT DOWNLOAD, INSTALL, OR USE THE SOFTWARE.**

## 1. PROPRIETARY SOFTWARE

The Software is proprietary and is not open source.

The Software is licensed, not sold. Isonapse and its licensors retain all ownership and intellectual property rights in the Software.

No source-code rights are granted. All rights not expressly granted under this Agreement are reserved.

## 2. PERMITTED USE

Subject to your compliance with this Agreement, Isonapse grants you a limited, non-exclusive, non-transferable, and non-sublicensable licence to download, install, and use the Software in unmodified binary and container-image form solely for:

- personal testing and evaluation;
- research;
- internal demonstrations and proofs of concept; and
- internal, non-production evaluation by an organisation.

The Software is made available free of charge under this Agreement.

A commercial organisation may evaluate the Software internally, provided that it is not used in production, in live operational workflows, as part of normal ongoing business operations, or to provide products or services to customers.

Employees and contractors may use the Software on behalf of an organisation only for that organisation’s permitted internal evaluation. The organisation is responsible for their compliance with this Agreement.

You may run Community Edition on systems that you control and let your own employees and contractors, and the agents and machines they use for you, use that Community Edition instance for the permitted uses above.

Configuring the Software through its documented settings, such as command options, environment variables, ports, storage volumes, and policies, is not a modification of the Software.

## 3. RESTRICTIONS

Except where mandatory law expressly permits otherwise, you may not:

- use the Software in production or for commercial purposes;
- sell, resell, rent, lease, sublicense, redistribute, publish, host, or otherwise make the Software available to another person or organisation;
- use the Software to provide consulting, managed services, hosting, outsourcing, or other services to third parties;
- embed, bundle, integrate, or white-label the Software in another product or service;
- modify, adapt, translate, or create derivative works of the Software;
- reverse engineer, decompile, disassemble, or attempt to derive its source code or non-public technical details;
- remove or alter proprietary notices;
- circumvent or disable technical, security, signing, integrity, or authentication measures; or
- use the Software unlawfully.

Letting your own employees and contractors use a Community Edition instance as Section 2 permits is not making the Software available to another person or organisation.

You may make temporary technical copies and reasonable backup copies necessary for permitted installation and use, including copies of the container images in your own container runtime or private registry.

Repository materials, including binaries, container images, checksums, scripts, Homebrew formulae or casks, and documentation, are also proprietary unless expressly stated otherwise.

## 4. PUBLIC BETA

The Software is pre-release beta software and may contain errors, defects, vulnerabilities, incomplete functionality, or compatibility issues.

The Software may be changed, suspended, or discontinued at any time. Isonapse is not required to provide support, maintenance, updates, patches, continued availability, or any service level.

Community Edition is self-hosted. There is no service level agreement for it: Isonapse does not operate, monitor, or back up any Community Edition instance, and does not guarantee the availability, performance, or recoverability of an instance or of the downloads and container images it relies on.

The Software is not guaranteed to detect, record, govern, block, or prevent every unsafe, unauthorised, unintended, or non-compliant agent action.

You remain responsible for supervising agent activity, reviewing outputs and actions, maintaining independent safeguards, protecting your systems and data, and meeting your own legal, security, and compliance obligations.

For Community Edition, you are also responsible for the systems and container runtime that run it, for who and what can access them, and for backing up its data and secrets. Any person or program that can control that container runtime can read or change Community Edition’s data and keys. Beta updates may change data formats, and removing Community Edition together with its data deletes that data permanently.

The Software must not be relied upon as the sole security, governance, access-control, audit, or compliance mechanism.

## 5. TELEMETRY AND DATA

The current version of the Software does not collect or transmit product telemetry, usage analytics, or personal data to Isonapse.

Logs, receipts, and policy data generated by the Software are stored locally on your systems and remain under your control.

Community Edition stores its database, the records it receives, its accounts, and its settings in storage on systems you control, such as a container volume. It also stores the credentials, API keys, and secrets that you enter or that it creates for you, such as its database key and administrator accounts; `isonapse setup` keeps the secrets that open the database in a file that only your user account can read. Isonapse does not receive this data or these credentials and cannot recover them if they are lost.

If you connect a machine to a Community Edition server, the Software sends signed records of agent decisions and enrolment metadata from that machine to the server you choose. That server is operated by you or your organisation, not by Isonapse.

Installing, setting up, and updating the Software downloads release files, Homebrew formulae, and container images from the platforms through which Isonapse distributes them, currently GitHub and its container registry. An optional update check, off by default, reads release metadata from GitHub. These requests send no user content. Community Edition otherwise connects to other services only when you ask it to, for example to fetch a file from an address you provide, or for agents and services you run and connect through it.

The Software may interact with third-party tools or services that you configure or use. Those interactions are subject to the applicable third party’s terms and privacy practices.

The Software may download third-party machine-learning models from their upstream repositories to your system. Those models are the property of their respective authors and are licensed to you under the authors’ own terms, not under this Agreement. A summary of these components and their licenses is provided in the accompanying `THIRD_PARTY_NOTICES.md`.

The native binaries in the Software's release archives, including the `isonapse` command-line tool, are compiled from Rust and statically link open-source libraries that are distributed inside those binaries. Those libraries are the property of their respective authors and are licensed to you under the authors’ own terms (predominantly MIT and Apache-2.0), not under this Agreement. A complete, generated manifest of these dependencies and their license and copyright texts is provided in the `THIRD_PARTY_DEPENDENCIES.md` in the same archive and is also printed by `isonapse licenses`.

The Community Edition container images also contain third-party open-source software: the Rust libraries of the server and control plane, the operating-system packages of their Linux base images, the Node.js runtime and JavaScript packages of the dashboard, and fonts. These components are the property of their respective authors and are licensed to you under their own terms, not under this Agreement. `THIRD_PARTY_NOTICES.md` describes these components and says where the license texts included with the Software are. Isonapse will provide any license or notice text that is not included with the Software on request.

Nothing in this Agreement limits any right you have under the license of a third-party component. Where such a license requires that its source code be made available, Isonapse will provide it, or tell you where to obtain it, on request.

Third-party distribution or hosting platforms may independently process technical or download-related information under their own terms.

If a future version introduces product telemetry or other data collection, Isonapse will disclose it in the documentation or terms accompanying that version.

## 6. FEEDBACK AND UPDATES

If you voluntarily provide feedback, suggestions, or ideas concerning the Software, you grant Isonapse a perpetual, worldwide, transferable, sublicensable, royalty-free licence to use and incorporate that feedback for any purpose.

This does not transfer ownership of your pre-existing software, data, content, confidential information, or other materials.

Isonapse may provide updated versions of the Software. Updated versions may be subject to updated terms, which will be provided or referenced with the update.

By installing or using an updated version after receiving notice of the updated terms, you agree to those terms.

## 7. NO WARRANTY

**THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE."**

TO THE MAXIMUM EXTENT PERMITTED BY LAW, ISONAPSE DISCLAIMS ALL EXPRESS, IMPLIED, AND STATUTORY WARRANTIES, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, SECURITY, COMPATIBILITY, AND UNINTERRUPTED OR ERROR-FREE OPERATION.

ISONAPSE DOES NOT WARRANT THAT THE SOFTWARE WILL MEET YOUR REQUIREMENTS, REMAIN AVAILABLE OR COMPATIBLE, IDENTIFY OR PREVENT EVERY UNSAFE OR UNAUTHORISED ACTION, OR BE SUITABLE FOR ANY LEGAL, SECURITY, AUDIT, COMPLIANCE, OR REGULATORY PURPOSE.

NOTHING IN THIS SECTION EXCLUDES ANY RIGHT OR WARRANTY THAT CANNOT LAWFULLY BE EXCLUDED.

## 8. LIMITATION OF LIABILITY

TO THE MAXIMUM EXTENT PERMITTED BY LAW, ISONAPSE AND ITS DIRECTORS, OFFICERS, EMPLOYEES, CONTRACTORS, AFFILIATES, AND LICENSORS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOSS OF PROFITS, REVENUE, BUSINESS, OPPORTUNITY, GOODWILL, OR DATA.

ISONAPSE’S TOTAL AGGREGATE LIABILITY ARISING OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THIS AGREEMENT WILL NOT EXCEED CHF 100.

NOTHING IN THIS AGREEMENT EXCLUDES OR LIMITS LIABILITY THAT CANNOT BE EXCLUDED OR LIMITED UNDER APPLICABLE LAW, INCLUDING LIABILITY FOR UNLAWFUL INTENT OR GROSS NEGLIGENCE.

NOTHING IN THIS AGREEMENT LIMITS MANDATORY CONSUMER RIGHTS.

## 9. TERMINATION

This Agreement remains effective until terminated.

Your licence terminates if you materially breach this Agreement and fail to remedy a remediable breach within fourteen days after receiving notice from Isonapse.

Isonapse may terminate the licence immediately for unauthorised distribution, commercial exploitation, intellectual-property infringement, unlawful use, or circumvention of security or integrity measures.

Isonapse may discontinue distribution, support, or maintenance of the Software at any time. Discontinuation alone does not terminate your licence to an existing version, unless continued use presents a material security, legal, integrity, or technical risk.

Upon termination, you must stop using and delete all copies of the Software under your control, including its container images. You may keep the data you created with the Software.

Provisions relating to restrictions, intellectual property, feedback, warranty, liability, governing law, and general interpretation survive termination.

## 10. GOVERNING LAW

This Agreement is governed by the substantive laws of Switzerland, excluding its conflict-of-law rules and the United Nations Convention on Contracts for the International Sale of Goods.

Subject to mandatory consumer rights and statutory venue rules, the courts of Zug, Switzerland have exclusive jurisdiction over disputes arising from this Agreement or the Software.

If any provision is invalid or unenforceable, the remaining provisions remain effective.

This Agreement constitutes the entire agreement between you and Isonapse concerning the Software and supersedes version 1.0 of this Agreement and any prior closed-beta participation agreement concerning the same Software.

You may not assign this Agreement without Isonapse’s prior written consent. Isonapse may assign it in connection with a merger, restructuring, financing, sale, or transfer of the relevant business or Software.

## 11. CONTACT

Questions concerning this Agreement, requests under Section 5, or commercial licensing may be sent to:

**licensing@isonapse.com**

Isonapse GmbH  
Zug, Switzerland
