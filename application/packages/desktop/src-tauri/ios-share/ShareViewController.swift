import ImageIO
import UIKit
import UniformTypeIdentifiers

/// The iOS share extension: PrivacyNotes in the system share sheet.
///
/// It runs in its own process and cannot reach the app, and it never holds the
/// vault keys. It presents one unified compact share sheet for web links, text,
/// photos, and files so the user can pick the destination (Bookmark, Clip page,
/// Note, Task, Journal, or Files), edit the title/note, and organize with a
/// Task list, Folder (Pro), or Tags before saving into the app group's inbox.
/// The app drains the inbox once the user has signed in and cleared the app
/// lock, encrypting every item like any other.
///
/// While App Lock is off, the main app mirrors non-PIN-protected task list
/// titles, Pro folder names, and tags into `ShareMeta/ShareCatalog.json` under
/// complete file protection and excluded from backups. When App Lock is on (or
/// after sign-out), that file is removed and the sheet falls back to Quick Tasks
/// and Unfiled without disclosing any vault names.
///
/// All UI strings come from the web catalogs: `packages/desktop/scripts/sync-version.mjs`
/// writes them into the `.lproj` folders beside this file.
/// Spec: docs/internal/specs/share-into-app.md
final class ShareViewController: UIViewController, UITextFieldDelegate, UITextViewDelegate {
    private static let appGroup = "group.app.privacynotes"
    /// The largest per-file limit the app grants (the storage add-on); the app's
    /// own check names the lower limits to the user. src/share_inbox.rs holds the
    /// same cap.
    private static let maxFileBytes = 100 * 1000 * 1000
    /// The app's own caps on shared text, titles, and tags; past them, text is cut here.
    private static let maxTextChars = 500_000
    private static let maxShortChars = 1_000
    private static let maxTags = 20
    private static let maxTagChars = 100
    /// Each folder is created with complete protection, so the files written into
    /// it inherit the class from their first byte.
    private static let protectedFolder: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]
    private static let maxFiles = 10
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        return f
    }()

    /// What the card tells the user. `tooLarge` wins over `saved`: a share of
    /// several files where some were over the limit saves the rest, and the user
    /// must still learn that some did not arrive.
    private enum Outcome {
        case saved
        case tooLarge(limit: Int)
        case failed
    }

    private enum ShareTarget: String {
        case bookmark
        case clip
        case note
        case task
        case journal
        case files

        var label: String {
            switch self {
            case .bookmark: return ShareViewController.localized("bookmark", fallback: "Bookmark")
            case .clip: return ShareViewController.localized("clipPage", fallback: "Clip page")
            case .note: return ShareViewController.localized("note", fallback: "Note")
            case .task: return ShareViewController.localized("task", fallback: "Task")
            case .journal: return ShareViewController.localized("journal", fallback: "Journal")
            case .files: return ShareViewController.localized("files", fallback: "Files")
            }
        }
    }

    private struct StagedFile {
        let id: String
        let tmp: URL
        let name: String
        let mime: String
    }

    private enum StageResult {
        case staged(StagedFile)
        case tooLarge
        case failed
    }

    private enum SheetPayload {
        case url(url: URL, title: String, note: String)
        case text(body: String)
        case photos(files: [StagedFile], initialNote: String, thumbnail: UIImage?)
        case files(files: [StagedFile], initialNote: String)

        var targets: [ShareTarget] {
            switch self {
            case .url: return [.bookmark, .clip, .task]
            case .text: return [.note, .task, .journal]
            case .photos: return [.note, .files, .journal]
            case .files: return [.files, .note]
            }
        }
    }

    private struct CatalogTaskList: Decodable {
        let id: String
        let title: String
    }

    private struct CatalogFolder: Decodable {
        let id: String
        let name: String
    }

    private struct ShareCatalog: Decodable {
        let v: Int?
        let foldersUnlocked: Bool?
        let taskLists: [CatalogTaskList]?
        let folders: [CatalogFolder]?
        let tags: [String]?

        static let empty = ShareCatalog(v: 1, foldersUnlocked: false, taskLists: [], folders: [], tags: [])
    }

    private let card = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private let stack = UIStackView()
    private var started = false

    // Unified sheet state
    private var composeSheet: UIView?
    private var segmented: UISegmentedControl?
    private var urlPreviewLabel: UILabel?
    private var titleField: UITextField?
    private var titleDivider: UIView?
    private var noteTextView: UITextView?
    private var notePlaceholderLabel: UILabel?
    private var fieldsContainer: UIStackView?
    private var filesSummaryLabel: UILabel?
    private var journalHintLabel: UILabel?
    private var taskListButton: UIButton?
    private var folderButton: UIButton?
    private var tagsRow: UIView?
    private var tagsChipsStack: UIStackView?
    private var tagInputField: UITextField?
    private var tagSuggestionsButton: UIButton?
    private var saveButton: UIButton?

    private var activePayload: SheetPayload?
    private var availableTargets: [ShareTarget] = []
    private var selectedTarget: ShareTarget = .note
    private var catalog: ShareCatalog = .empty
    private var selectedTaskListId: String?
    private var selectedFolderId: String?
    private var selectedTags: [String] = []
    private var stagedGroup: URL?
    private var stagedInbox: URL?
    private var stagedFiles: [StagedFile] = []
    private var stagedTooLarge = 0
    private var stagedLimit = maxFileBytes
    private var saving = false

    deinit {
        for file in stagedFiles {
            try? FileManager.default.removeItem(at: file.tmp)
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.28)
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.startAnimating()
        stack.addArrangedSubview(spinner)
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.layer.cornerRadius = 18
        card.clipsToBounds = true
        card.translatesAutoresizingMaskIntoConstraints = false
        card.contentView.addSubview(stack)
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 260),
            card.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),
            stack.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -20),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        Task {
            await self.handleShare(items: items)
        }
    }

    private func handleShare(items: [NSExtensionItem]) async {
        guard let inboxInfo = Self.prepareInbox() else {
            await confirm(.failed)
            extensionContext?.completeRequest(returningItems: nil)
            return
        }
        let providers = items.flatMap { $0.attachments ?? [] }
        let itemText = items.compactMap { ($0.attributedContentText ?? $0.attributedTitle)?.string }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }

        // Classify incoming attachments up to the activation limit.
        var urls: [URL] = []
        var texts: [String] = []
        var imageProviders: [(NSItemProvider, UTType)] = []
        var otherFileProviders: [(NSItemProvider, UTType)] = []
        for provider in providers.prefix(Self.maxFiles + 1) {
            if let url = await Self.webURL(provider) {
                urls.append(url)
            } else if let text = await Self.plainText(provider) {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    texts.append(trimmed)
                }
            } else if let type = Self.fileType(provider) {
                if type.conforms(to: .image) {
                    if imageProviders.count + otherFileProviders.count < Self.maxFiles {
                        imageProviders.append((provider, type))
                    }
                } else if imageProviders.count + otherFileProviders.count < Self.maxFiles {
                    otherFileProviders.append((provider, type))
                }
            }
        }

        // Plain text containing only one valid http(s) URL is treated as a web link.
        if urls.isEmpty && imageProviders.isEmpty && otherFileProviders.isEmpty {
            let combined = texts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
            let candidate = combined.isEmpty ? (itemText ?? "") : combined
            if let lone = Self.loneWebURL(candidate) {
                urls.append(lone)
                texts.removeAll()
            }
        }

        let sharedNote = texts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let loadedCatalog = Self.readCatalog(inboxInfo.group)
        let lastPick = Self.readLastPick(inboxInfo.group)

        // 1. Single web link (no files).
        if urls.count == 1 && imageProviders.isEmpty && otherFileProviders.isEmpty {
            let url = urls[0]
            let rawTitle = itemText ?? (sharedNote == url.absoluteString ? "" : sharedNote)
            let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            let extraNote = (itemText != nil && !sharedNote.isEmpty && sharedNote != url.absoluteString && sharedNote != title) ? sharedNote : ""
            configureSheetState(
                payload: .url(url: url, title: String(title.prefix(Self.maxShortChars)), note: String(extraNote.prefix(Self.maxTextChars))),
                staged: [],
                tooLarge: 0,
                inboxInfo: inboxInfo,
                catalog: loadedCatalog,
                lastPick: lastPick
            )
            presentUnifiedSheet()
            return
        }

        // 2. Text / mail snippet (no URLs, no files).
        if urls.isEmpty && imageProviders.isEmpty && otherFileProviders.isEmpty {
            let body = sharedNote.isEmpty ? (itemText ?? "") : sharedNote
            if !body.isEmpty {
                configureSheetState(
                    payload: .text(body: String(body.prefix(Self.maxTextChars))),
                    staged: [],
                    tooLarge: 0,
                    inboxInfo: inboxInfo,
                    catalog: loadedCatalog,
                    lastPick: lastPick
                )
                presentUnifiedSheet()
                return
            }
        }

        // 3. Photo-only share (1..maxFiles images, no URLs or non-image files).
        if urls.isEmpty && !imageProviders.isEmpty && otherFileProviders.isEmpty {
            var staged: [StagedFile] = []
            var tooLarge = 0
            for (index, (provider, type)) in imageProviders.enumerated() {
                switch await Self.stageFile(provider, type: type, index: index, limit: inboxInfo.limit, inbox: inboxInfo.inbox) {
                case .staged(let file): staged.append(file)
                case .tooLarge: tooLarge += 1
                case .failed: break
                }
            }
            guard !staged.isEmpty else {
                await confirm(tooLarge > 0 ? .tooLarge(limit: inboxInfo.limit) : .failed)
                extensionContext?.completeRequest(returningItems: nil)
                return
            }
            let thumb = Self.makeThumbnail(from: staged[0].tmp.appendingPathComponent("payload"), maxPixelSize: 240)
            let initialNote = sharedNote.isEmpty ? (itemText ?? "") : sharedNote
            configureSheetState(
                payload: .photos(files: staged, initialNote: String(initialNote.prefix(Self.maxTextChars)), thumbnail: thumb),
                staged: staged,
                tooLarge: tooLarge,
                inboxInfo: inboxInfo,
                catalog: loadedCatalog,
                lastPick: lastPick
            )
            presentUnifiedSheet()
            return
        }

        // 4. Other files (or mixed photos + documents), no URLs.
        if urls.isEmpty && !otherFileProviders.isEmpty {
            let allFileProviders = imageProviders + otherFileProviders
            var staged: [StagedFile] = []
            var tooLarge = 0
            for (index, (provider, type)) in allFileProviders.enumerated() {
                switch await Self.stageFile(provider, type: type, index: index, limit: inboxInfo.limit, inbox: inboxInfo.inbox) {
                case .staged(let file): staged.append(file)
                case .tooLarge: tooLarge += 1
                case .failed: break
                }
            }
            guard !staged.isEmpty else {
                await confirm(tooLarge > 0 ? .tooLarge(limit: inboxInfo.limit) : .failed)
                extensionContext?.completeRequest(returningItems: nil)
                return
            }
            let initialNote = sharedNote.isEmpty ? (itemText ?? "") : sharedNote
            configureSheetState(
                payload: .files(files: staged, initialNote: String(initialNote.prefix(Self.maxTextChars))),
                staged: staged,
                tooLarge: tooLarge,
                inboxInfo: inboxInfo,
                catalog: loadedCatalog,
                lastPick: lastPick
            )
            presentUnifiedSheet()
            return
        }

        // Fallback for rare mixed multi-kind batches (e.g. URL + files together).
        let outcome = await Self.saveAllImmediate(providers: providers, itemText: itemText, inbox: inboxInfo.inbox, limit: inboxInfo.limit)
        await confirm(outcome)
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func configureSheetState(
        payload: SheetPayload,
        staged: [StagedFile],
        tooLarge: Int,
        inboxInfo: (group: URL, inbox: URL, limit: Int),
        catalog: ShareCatalog,
        lastPick: String?
    ) {
        self.activePayload = payload
        self.availableTargets = payload.targets
        self.selectedTarget = payload.targets[0]
        self.stagedGroup = inboxInfo.group
        self.stagedInbox = inboxInfo.inbox
        self.stagedFiles = staged
        self.stagedTooLarge = tooLarge
        self.stagedLimit = inboxInfo.limit
        self.catalog = catalog
        let knownTaskIds = Set((catalog.taskLists ?? []).map { $0.id })
        self.selectedTaskListId = (lastPick != nil && knownTaskIds.contains(lastPick!)) ? lastPick : nil
        self.selectedFolderId = nil
        self.selectedTags = []
    }

    private func presentUnifiedSheet() {
        guard let payload = activePayload else { return }
        card.isHidden = true

        let sheet = UIView()
        sheet.backgroundColor = .systemBackground
        sheet.layer.cornerRadius = 20
        sheet.layer.cornerCurve = .continuous
        sheet.clipsToBounds = true
        sheet.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sheet)
        composeSheet = sheet

        let dismissTap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        dismissTap.cancelsTouchesInView = false
        view.addGestureRecognizer(dismissTap)

        // Header: Cancel (X) | PrivacyNotes | Save
        let cancelBtn = UIButton(type: .system)
        var cancelConfig = UIButton.Configuration.filled()
        cancelConfig.baseBackgroundColor = .secondarySystemFill
        cancelConfig.baseForegroundColor = .label
        cancelConfig.cornerStyle = .capsule
        cancelConfig.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold))
        cancelConfig.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        cancelBtn.configuration = cancelConfig
        cancelBtn.accessibilityLabel = Self.localized("cancel", fallback: "Cancel")
        cancelBtn.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancelBtn.translatesAutoresizingMaskIntoConstraints = false

        let appTitle = UILabel()
        appTitle.text = "PrivacyNotes"
        appTitle.font = .preferredFont(forTextStyle: .headline)
        appTitle.adjustsFontForContentSizeCategory = true
        appTitle.textColor = .label
        appTitle.textAlignment = .center
        appTitle.translatesAutoresizingMaskIntoConstraints = false

        let saveBtn = UIButton(type: .system)
        var saveConfig = UIButton.Configuration.filled()
        saveConfig.cornerStyle = .capsule
        saveConfig.title = Self.localized("save", fallback: "Save")
        saveConfig.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: 16, bottom: 7, trailing: 16)
        saveConfig.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var out = incoming
            out.font = .preferredFont(forTextStyle: .subheadline)
            return out
        }
        saveBtn.configuration = saveConfig
        saveBtn.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)
        saveBtn.translatesAutoresizingMaskIntoConstraints = false
        saveButton = saveBtn

        let header = UIView()
        header.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(cancelBtn)
        header.addSubview(appTitle)
        header.addSubview(saveBtn)

        let headerDivider = UIView()
        headerDivider.backgroundColor = .separator
        headerDivider.translatesAutoresizingMaskIntoConstraints = false

        // Segmented target picker
        let seg = UISegmentedControl(items: availableTargets.map { $0.label })
        seg.selectedSegmentIndex = 0
        seg.addTarget(self, action: #selector(targetChanged), for: .valueChanged)
        seg.translatesAutoresizingMaskIntoConstraints = false
        segmented = seg

        // Editable title + body fields
        let titleInput = UITextField()
        titleInput.placeholder = Self.localized("titlePlaceholder", fallback: "Title (optional)")
        titleInput.font = .preferredFont(forTextStyle: .headline)
        titleInput.adjustsFontForContentSizeCategory = true
        titleInput.textColor = .label
        titleInput.returnKeyType = .next
        titleInput.autocapitalizationType = .sentences
        titleInput.clearButtonMode = .whileEditing
        titleInput.delegate = self
        titleInput.translatesAutoresizingMaskIntoConstraints = false
        titleField = titleInput

        let fieldDivider = UIView()
        fieldDivider.backgroundColor = .separator
        fieldDivider.translatesAutoresizingMaskIntoConstraints = false
        fieldDivider.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true
        titleDivider = fieldDivider

        let noteView = UITextView()
        noteView.font = .preferredFont(forTextStyle: .body)
        noteView.adjustsFontForContentSizeCategory = true
        noteView.textColor = .label
        noteView.backgroundColor = .clear
        noteView.textContainerInset = UIEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        noteView.textContainer.lineFragmentPadding = 0
        noteView.delegate = self
        noteView.translatesAutoresizingMaskIntoConstraints = false
        noteView.heightAnchor.constraint(equalToConstant: 82).isActive = true
        noteTextView = noteView

        let placeholder = UILabel()
        placeholder.text = Self.localized("notePlaceholder", fallback: "Add a note...")
        placeholder.font = .preferredFont(forTextStyle: .body)
        placeholder.adjustsFontForContentSizeCategory = true
        placeholder.textColor = .placeholderText
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        noteView.addSubview(placeholder)
        notePlaceholderLabel = placeholder
        NSLayoutConstraint.activate([
            placeholder.topAnchor.constraint(equalTo: noteView.topAnchor, constant: 6),
            placeholder.leadingAnchor.constraint(equalTo: noteView.leadingAnchor),
            placeholder.trailingAnchor.constraint(lessThanOrEqualTo: noteView.trailingAnchor),
        ])

        // Populate initial content based on payload kind.
        let urlLabel = UILabel()
        urlLabel.font = .preferredFont(forTextStyle: .footnote)
        urlLabel.adjustsFontForContentSizeCategory = true
        urlLabel.textColor = .secondaryLabel
        urlLabel.lineBreakMode = .byTruncatingMiddle
        urlLabel.isHidden = true
        urlLabel.translatesAutoresizingMaskIntoConstraints = false
        urlPreviewLabel = urlLabel

        var summaryText = ""
        var previewAccessory: UIView?

        switch payload {
        case .url(let url, let title, let note):
            urlLabel.text = url.absoluteString
            urlLabel.isHidden = false
            titleInput.text = title.isEmpty ? (url.host ?? url.absoluteString) : title
            noteView.text = note
        case .text(let body):
            titleInput.text = ""
            noteView.text = body
        case .photos(let files, let initialNote, let thumbnail):
            noteView.text = initialNote
            summaryText = files.count == 1
                ? files[0].name
                : Self.localized("photoCount", fallback: "{{count}} photos").replacingOccurrences(of: "{{count}}", with: String(files.count))
            previewAccessory = Self.makePreviewBox(image: thumbnail, fallbackSymbol: "photo", extraCount: files.count - 1)
        case .files(let files, let initialNote):
            titleInput.text = files.count == 1 ? files[0].name : ""
            noteView.text = initialNote
            summaryText = files.count == 1
                ? files[0].name
                : Self.localized("fileCount", fallback: "{{count}} files").replacingOccurrences(of: "{{count}}", with: String(files.count))
            previewAccessory = Self.makePreviewBox(image: nil, fallbackSymbol: "doc.fill", extraCount: files.count - 1)
        }
        placeholder.isHidden = !noteView.text.isEmpty

        let fieldsStack = UIStackView(arrangedSubviews: [urlLabel, titleInput, fieldDivider, noteView])
        fieldsStack.axis = .vertical
        fieldsStack.spacing = 6
        fieldsStack.translatesAutoresizingMaskIntoConstraints = false
        fieldsContainer = fieldsStack

        let filesLabel = UILabel()
        filesLabel.text = summaryText
        filesLabel.font = .preferredFont(forTextStyle: .subheadline)
        filesLabel.adjustsFontForContentSizeCategory = true
        filesLabel.textColor = .secondaryLabel
        filesLabel.numberOfLines = 2
        filesLabel.isHidden = true
        filesLabel.translatesAutoresizingMaskIntoConstraints = false
        filesSummaryLabel = filesLabel

        let leftStack = UIStackView(arrangedSubviews: [fieldsStack, filesLabel])
        leftStack.axis = .vertical
        leftStack.spacing = 6
        leftStack.translatesAutoresizingMaskIntoConstraints = false

        let bodyRow = UIStackView(arrangedSubviews: previewAccessory != nil ? [leftStack, previewAccessory!] : [leftStack])
        bodyRow.axis = .horizontal
        bodyRow.alignment = .top
        bodyRow.spacing = 12
        bodyRow.translatesAutoresizingMaskIntoConstraints = false

        let journalHint = UILabel()
        journalHint.text = Self.localized("journalHint", fallback: "Appends to today's journal entry.")
        journalHint.font = .preferredFont(forTextStyle: .footnote)
        journalHint.adjustsFontForContentSizeCategory = true
        journalHint.textColor = .secondaryLabel
        journalHint.numberOfLines = 0
        journalHint.isHidden = true
        journalHint.translatesAutoresizingMaskIntoConstraints = false
        journalHintLabel = journalHint

        let orgDivider = UIView()
        orgDivider.backgroundColor = .separator
        orgDivider.translatesAutoresizingMaskIntoConstraints = false
        orgDivider.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true

        // Task list pull-down menu button (Task mode)
        let taskBtn = Self.makeMenuButton()
        taskListButton = taskBtn

        // Folder pull-down menu button (Pro accounts when folders are available)
        let fldBtn = Self.makeMenuButton()
        folderButton = fldBtn

        // Tags row: chips scroll view + inline input + optional existing tags menu
        let tagsContainer = buildTagsRow()
        tagsRow = tagsContainer

        let orgStack = UIStackView(arrangedSubviews: [taskBtn, fldBtn, tagsContainer])
        orgStack.axis = .vertical
        orgStack.spacing = 8
        orgStack.translatesAutoresizingMaskIntoConstraints = false

        var arranged: [UIView] = [seg, bodyRow, journalHint, orgDivider, orgStack]
        if !summaryText.isEmpty {
            let footLabel = UILabel()
            footLabel.text = summaryText
            footLabel.font = .preferredFont(forTextStyle: .footnote)
            footLabel.adjustsFontForContentSizeCategory = true
            footLabel.textColor = .secondaryLabel
            footLabel.lineBreakMode = .byTruncatingMiddle
            arranged.append(footLabel)
        }

        let contentStack = UIStackView(arrangedSubviews: arranged)
        contentStack.axis = .vertical
        contentStack.spacing = 12
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        let scroll = UIScrollView()
        scroll.alwaysBounceVertical = false
        scroll.showsVerticalScrollIndicator = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(contentStack)

        sheet.addSubview(header)
        sheet.addSubview(headerDivider)
        sheet.addSubview(scroll)

        let centerY = sheet.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        centerY.priority = .defaultLow

        let scrollHeight = scroll.heightAnchor.constraint(equalTo: contentStack.heightAnchor, constant: 28)
        scrollHeight.priority = .defaultHigh

        NSLayoutConstraint.activate([
            sheet.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            sheet.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            sheet.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            sheet.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            {
                let fill = sheet.widthAnchor.constraint(equalTo: view.safeAreaLayoutGuide.widthAnchor, constant: -32)
                fill.priority = .defaultHigh
                return fill
            }(),
            sheet.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor, constant: 14),
            sheet.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -10),
            centerY,

            header.topAnchor.constraint(equalTo: sheet.topAnchor, constant: 12),
            header.leadingAnchor.constraint(equalTo: sheet.leadingAnchor, constant: 14),
            header.trailingAnchor.constraint(equalTo: sheet.trailingAnchor, constant: -14),
            header.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),

            cancelBtn.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            cancelBtn.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            cancelBtn.widthAnchor.constraint(equalToConstant: 32),
            cancelBtn.heightAnchor.constraint(equalToConstant: 32),

            saveBtn.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            saveBtn.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            saveBtn.topAnchor.constraint(greaterThanOrEqualTo: header.topAnchor),
            saveBtn.bottomAnchor.constraint(lessThanOrEqualTo: header.bottomAnchor),

            appTitle.centerXAnchor.constraint(equalTo: header.centerXAnchor),
            appTitle.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            appTitle.leadingAnchor.constraint(greaterThanOrEqualTo: cancelBtn.trailingAnchor, constant: 8),
            appTitle.trailingAnchor.constraint(lessThanOrEqualTo: saveBtn.leadingAnchor, constant: -8),

            headerDivider.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            headerDivider.leadingAnchor.constraint(equalTo: sheet.leadingAnchor),
            headerDivider.trailingAnchor.constraint(equalTo: sheet.trailingAnchor),
            headerDivider.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),

            scroll.topAnchor.constraint(equalTo: headerDivider.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: sheet.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: sheet.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: sheet.bottomAnchor),
            scrollHeight,

            contentStack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 14),
            contentStack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 16),
            contentStack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -16),
            contentStack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -14),
            contentStack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -32),
        ])

        refreshTaskListMenu()
        refreshFolderMenu()
        refreshTagSuggestionsMenu()
        applyTargetUI()
    }

    private static func makePreviewBox(image: UIImage?, fallbackSymbol: String, extraCount: Int) -> UIView {
        let thumbBox = UIView()
        thumbBox.backgroundColor = .secondarySystemBackground
        thumbBox.layer.cornerRadius = 12
        thumbBox.layer.cornerCurve = .continuous
        thumbBox.layer.borderWidth = 1 / UIScreen.main.scale
        thumbBox.layer.borderColor = UIColor.separator.cgColor
        thumbBox.clipsToBounds = true
        thumbBox.translatesAutoresizingMaskIntoConstraints = false

        let thumbImg = UIImageView(image: image ?? UIImage(systemName: fallbackSymbol))
        thumbImg.contentMode = image != nil ? .scaleAspectFill : .scaleAspectFit
        thumbImg.tintColor = .secondaryLabel
        thumbImg.translatesAutoresizingMaskIntoConstraints = false
        thumbBox.addSubview(thumbImg)
        let pad: CGFloat = image != nil ? 0 : 18
        NSLayoutConstraint.activate([
            thumbBox.widthAnchor.constraint(equalToConstant: 72),
            thumbBox.heightAnchor.constraint(equalToConstant: 72),
            thumbImg.topAnchor.constraint(equalTo: thumbBox.topAnchor, constant: pad),
            thumbImg.bottomAnchor.constraint(equalTo: thumbBox.bottomAnchor, constant: -pad),
            thumbImg.leadingAnchor.constraint(equalTo: thumbBox.leadingAnchor, constant: pad),
            thumbImg.trailingAnchor.constraint(equalTo: thumbBox.trailingAnchor, constant: -pad),
        ])

        if extraCount > 0 {
            let badge = UILabel()
            badge.text = "+\(extraCount)"
            badge.font = .systemFont(ofSize: 12, weight: .semibold)
            badge.textColor = .white
            badge.backgroundColor = UIColor.black.withAlphaComponent(0.68)
            badge.textAlignment = .center
            badge.layer.cornerRadius = 9
            badge.clipsToBounds = true
            badge.translatesAutoresizingMaskIntoConstraints = false
            thumbBox.addSubview(badge)
            NSLayoutConstraint.activate([
                badge.trailingAnchor.constraint(equalTo: thumbBox.trailingAnchor, constant: -5),
                badge.bottomAnchor.constraint(equalTo: thumbBox.bottomAnchor, constant: -5),
                badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 24),
                badge.heightAnchor.constraint(equalToConstant: 18),
            ])
        }
        return thumbBox
    }

    private static func makeMenuButton() -> UIButton {
        let btn = UIButton(type: .system)
        var config = UIButton.Configuration.filled()
        config.baseBackgroundColor = .secondarySystemBackground
        config.baseForegroundColor = .label
        config.cornerStyle = .medium
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)
        config.imagePlacement = .trailing
        config.imagePadding = 6
        config.image = UIImage(systemName: "chevron.up.chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .medium))
        btn.configuration = config
        btn.contentHorizontalAlignment = .fill
        btn.showsMenuAsPrimaryAction = true
        btn.translatesAutoresizingMaskIntoConstraints = false
        return btn
    }

    private func buildTagsRow() -> UIView {
        let wrapper = UIStackView()
        wrapper.axis = .vertical
        wrapper.spacing = 6
        wrapper.translatesAutoresizingMaskIntoConstraints = false

        let chipsScroll = UIScrollView()
        chipsScroll.showsHorizontalScrollIndicator = false
        chipsScroll.isHidden = true
        chipsScroll.translatesAutoresizingMaskIntoConstraints = false

        let chipsStack = UIStackView()
        chipsStack.axis = .horizontal
        chipsStack.spacing = 6
        chipsStack.alignment = .center
        chipsStack.translatesAutoresizingMaskIntoConstraints = false
        chipsScroll.addSubview(chipsStack)
        NSLayoutConstraint.activate([
            chipsStack.topAnchor.constraint(equalTo: chipsScroll.contentLayoutGuide.topAnchor),
            chipsStack.bottomAnchor.constraint(equalTo: chipsScroll.contentLayoutGuide.bottomAnchor),
            chipsStack.leadingAnchor.constraint(equalTo: chipsScroll.contentLayoutGuide.leadingAnchor),
            chipsStack.trailingAnchor.constraint(equalTo: chipsScroll.contentLayoutGuide.trailingAnchor),
            chipsStack.heightAnchor.constraint(equalTo: chipsScroll.frameLayoutGuide.heightAnchor),
            chipsScroll.heightAnchor.constraint(equalToConstant: 28),
        ])
        tagsChipsStack = chipsStack

        let inputRow = UIStackView()
        inputRow.axis = .horizontal
        inputRow.spacing = 8
        inputRow.alignment = .center
        inputRow.translatesAutoresizingMaskIntoConstraints = false

        let field = UITextField()
        field.placeholder = Self.localized("addTagPlaceholder", fallback: "Add tag...")
        field.font = .preferredFont(forTextStyle: .subheadline)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = .label
        field.backgroundColor = .secondarySystemBackground
        field.layer.cornerRadius = 8
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 1))
        field.leftViewMode = .always
        field.rightView = UIView(frame: CGRect(x: 0, y: 0, width: 8, height: 1))
        field.rightViewMode = .always
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .done
        field.delegate = self
        field.addTarget(self, action: #selector(tagFieldChanged), for: .editingChanged)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.heightAnchor.constraint(equalToConstant: 34).isActive = true
        tagInputField = field

        let pickBtn = UIButton(type: .system)
        var pickConfig = UIButton.Configuration.filled()
        pickConfig.baseBackgroundColor = .secondarySystemBackground
        pickConfig.baseForegroundColor = .label
        pickConfig.cornerStyle = .medium
        pickConfig.image = UIImage(systemName: "number", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold))
        pickConfig.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: 10, bottom: 7, trailing: 10)
        pickBtn.configuration = pickConfig
        pickBtn.accessibilityLabel = Self.localized("tags", fallback: "Tags")
        pickBtn.showsMenuAsPrimaryAction = true
        pickBtn.translatesAutoresizingMaskIntoConstraints = false
        pickBtn.heightAnchor.constraint(equalToConstant: 34).isActive = true
        tagSuggestionsButton = pickBtn

        inputRow.addArrangedSubview(field)
        inputRow.addArrangedSubview(pickBtn)

        wrapper.addArrangedSubview(chipsScroll)
        wrapper.addArrangedSubview(inputRow)
        return wrapper
    }

    private func refreshTaskListMenu() {
        guard let btn = taskListButton else { return }
        let quickTitle = Self.localized("quickTasks", fallback: "Quick Tasks")
        let labelPrefix = Self.localized("taskList", fallback: "Task list")
        let lists = catalog.taskLists ?? []
        let currentName = lists.first(where: { $0.id == selectedTaskListId })?.title ?? quickTitle

        var config = btn.configuration ?? UIButton.Configuration.filled()
        config.title = "\(labelPrefix): \(currentName)"
        btn.configuration = config

        var actions: [UIAction] = [
            UIAction(title: quickTitle, state: selectedTaskListId == nil ? .on : .off) { [weak self] _ in
                self?.selectedTaskListId = nil
                self?.refreshTaskListMenu()
            }
        ]
        for list in lists {
            actions.append(UIAction(title: list.title, state: selectedTaskListId == list.id ? .on : .off) { [weak self] _ in
                self?.selectedTaskListId = list.id
                self?.refreshTaskListMenu()
            })
        }
        btn.menu = UIMenu(children: actions)
    }

    private func refreshFolderMenu() {
        guard let btn = folderButton else { return }
        let folders = (catalog.foldersUnlocked == true) ? (catalog.folders ?? []) : []
        let unfiled = Self.localized("unfiled", fallback: "Unfiled")
        let labelPrefix = Self.localized("folder", fallback: "Folder")
        let currentName = folders.first(where: { $0.id == selectedFolderId })?.name ?? unfiled

        var config = btn.configuration ?? UIButton.Configuration.filled()
        config.title = "\(labelPrefix): \(currentName)"
        btn.configuration = config

        var actions: [UIAction] = [
            UIAction(title: unfiled, state: selectedFolderId == nil ? .on : .off) { [weak self] _ in
                self?.selectedFolderId = nil
                self?.refreshFolderMenu()
            }
        ]
        for folder in folders {
            actions.append(UIAction(title: folder.name, state: selectedFolderId == folder.id ? .on : .off) { [weak self] _ in
                self?.selectedFolderId = folder.id
                self?.refreshFolderMenu()
            })
        }
        btn.menu = UIMenu(children: actions)
    }

    private func refreshTagSuggestionsMenu() {
        guard let btn = tagSuggestionsButton else { return }
        let existing = (catalog.tags ?? []).filter { !selectedTags.contains($0) }
        btn.isHidden = existing.isEmpty
        if existing.isEmpty { return }
        let actions = existing.prefix(30).map { tag in
            UIAction(title: "#\(tag)") { [weak self] _ in
                self?.addTag(tag)
            }
        }
        btn.menu = UIMenu(title: Self.localized("tags", fallback: "Tags"), children: actions)
    }

    private func refreshTagChips() {
        guard let stack = tagsChipsStack, let scroll = stack.superview as? UIScrollView else { return }
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        scroll.isHidden = selectedTags.isEmpty
        for (idx, tag) in selectedTags.enumerated() {
            let chip = UIButton(type: .system)
            var config = UIButton.Configuration.filled()
            config.baseBackgroundColor = .tertiarySystemFill
            config.baseForegroundColor = .label
            config.cornerStyle = .capsule
            config.title = "#\(tag)"
            config.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .bold))
            config.imagePlacement = .trailing
            config.imagePadding = 4
            config.contentInsets = NSDirectionalEdgeInsets(top: 3, leading: 9, bottom: 3, trailing: 8)
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var out = incoming
                out.font = .preferredFont(forTextStyle: .footnote)
                return out
            }
            chip.configuration = config
            chip.tag = idx
            chip.addTarget(self, action: #selector(removeTagTapped(_:)), for: .touchUpInside)
            stack.addArrangedSubview(chip)
        }
        refreshTagSuggestionsMenu()
    }

    private func addTag(_ raw: String) {
        guard selectedTags.count < Self.maxTags else { return }
        let cleaned = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        let clipped = String(cleaned.prefix(Self.maxTagChars))
        guard !selectedTags.contains(where: { $0.caseInsensitiveCompare(clipped) == .orderedSame }) else { return }
        selectedTags.append(clipped)
        refreshTagChips()
    }

    private func commitTagInput() {
        guard let text = tagInputField?.text, !text.isEmpty else { return }
        let separators = CharacterSet(charactersIn: ",\u{060C}\u{3001}\u{FF0C}\n")
        for part in text.components(separatedBy: separators) {
            addTag(part)
        }
        tagInputField?.text = ""
    }

    @objc private func tagFieldChanged() {
        guard let text = tagInputField?.text else { return }
        if text.contains(",") || text.contains("\u{060C}") || text.contains("\u{3001}") || text.contains("\u{FF0C}") {
            commitTagInput()
        }
    }

    @objc private func removeTagTapped(_ sender: UIButton) {
        let idx = sender.tag
        guard idx >= 0 && idx < selectedTags.count else { return }
        selectedTags.remove(at: idx)
        refreshTagChips()
    }

    private func applyTargetUI() {
        guard let payload = activePayload else { return }
        let target = selectedTarget
        let isFiles = target == .files
        let isTask = target == .task
        let isJournal = target == .journal

        fieldsContainer?.isHidden = isFiles
        filesSummaryLabel?.isHidden = !isFiles
        journalHintLabel?.isHidden = !isJournal

        switch payload {
        case .url:
            urlPreviewLabel?.isHidden = false
            titleField?.isHidden = false
            titleField?.placeholder = isTask
                ? Self.localized("taskPlaceholder", fallback: "Task item...")
                : Self.localized("titlePlaceholder", fallback: "Title (optional)")
            titleDivider?.isHidden = isTask
            noteTextView?.isHidden = isTask
        case .text:
            urlPreviewLabel?.isHidden = true
            let showTitle = target == .note
            titleField?.isHidden = !showTitle
            titleDivider?.isHidden = !showTitle
            noteTextView?.isHidden = false
            notePlaceholderLabel?.text = isTask
                ? Self.localized("taskPlaceholder", fallback: "Task item...")
                : Self.localized("notePlaceholder", fallback: "Add a note...")
        case .photos:
            urlPreviewLabel?.isHidden = true
            let showTitle = target == .note
            titleField?.isHidden = !showTitle
            titleDivider?.isHidden = !showTitle
            noteTextView?.isHidden = isFiles
            notePlaceholderLabel?.text = Self.localized("notePlaceholder", fallback: "Add a note...")
        case .files:
            urlPreviewLabel?.isHidden = true
            titleField?.isHidden = isFiles
            titleDivider?.isHidden = isFiles
            noteTextView?.isHidden = isFiles
            notePlaceholderLabel?.text = Self.localized("notePlaceholder", fallback: "Add a note...")
        }

        taskListButton?.isHidden = !isTask
        let showFolder = !isTask && !isJournal && (catalog.foldersUnlocked == true) && !(catalog.folders ?? []).isEmpty
        folderButton?.isHidden = !showFolder
        tagsRow?.isHidden = isTask

        if isFiles {
            view.endEditing(true)
        }
    }

    @objc private func dismissKeyboard() {
        view.endEditing(true)
    }

    @objc private func targetChanged() {
        let idx = segmented?.selectedSegmentIndex ?? 0
        guard idx >= 0 && idx < availableTargets.count else { return }
        selectedTarget = availableTargets[idx]
        applyTargetUI()
    }

    @objc private func cancelTapped() {
        guard !saving else { return }
        view.endEditing(true)
        let toDelete = stagedFiles
        stagedFiles = []
        for file in toDelete {
            try? FileManager.default.removeItem(at: file.tmp)
        }
        extensionContext?.completeRequest(returningItems: nil)
    }

    @objc private func saveTapped() {
        guard !saving, let inbox = stagedInbox, let payload = activePayload else { return }
        saving = true
        saveButton?.isEnabled = false
        commitTagInput()
        view.endEditing(true)

        let target = selectedTarget
        let rawTitle = (titleField?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let rawText = (noteTextView?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let title = String(rawTitle.prefix(Self.maxShortChars))
        let text = String(rawText.prefix(Self.maxTextChars))
        let taskListId = target == .task ? selectedTaskListId : nil
        let folderId = (target != .task && target != .journal) ? selectedFolderId : nil
        let tags = target == .task ? [] : selectedTags
        let files = stagedFiles
        stagedFiles = []
        let tooLarge = stagedTooLarge
        let limit = stagedLimit
        let groupDir = stagedGroup

        composeSheet?.isHidden = true
        card.isHidden = false

        Task {
            if target == .task, let groupDir {
                Self.writeLastPick(taskListId, in: groupDir)
            }
            var written = 0
            switch payload {
            case .url(let url, _, _):
                var fields: [String: Any] = [
                    "kind": "url",
                    "url": url.absoluteString,
                    "target": target.rawValue,
                ]
                if !title.isEmpty { fields["title"] = title }
                if target != .task && !text.isEmpty { fields["text"] = text }
                if let taskListId { fields["taskListId"] = taskListId }
                if let folderId { fields["folderId"] = folderId }
                if !tags.isEmpty { fields["tags"] = tags }
                if Self.write(fields, inbox: inbox) { written += 1 }

            case .text(let originalBody):
                let finalBody = text.isEmpty ? originalBody : text
                var fields: [String: Any] = [
                    "kind": "text",
                    "text": finalBody,
                    "target": target.rawValue,
                ]
                if target == .note && !title.isEmpty { fields["title"] = title }
                if let taskListId { fields["taskListId"] = taskListId }
                if let folderId { fields["folderId"] = folderId }
                if !tags.isEmpty { fields["tags"] = tags }
                if Self.write(fields, inbox: inbox) { written += 1 }

            case .photos, .files:
                let group = UUID().uuidString
                for file in files {
                    var fields: [String: Any] = [
                        "kind": "file",
                        "name": file.name,
                        "mime": file.mime,
                        "target": target.rawValue,
                    ]
                    if target == .note || target == .journal {
                        fields["group"] = group
                        if target == .note && !title.isEmpty { fields["title"] = title }
                        if !text.isEmpty { fields["text"] = text }
                    }
                    if let folderId { fields["folderId"] = folderId }
                    if !tags.isEmpty { fields["tags"] = tags }
                    if Self.finish(fields, tmp: file.tmp, id: file.id, inbox: inbox) {
                        written += 1
                    }
                }
            }

            let outcome: Outcome
            if tooLarge > 0 {
                outcome = .tooLarge(limit: limit)
            } else {
                outcome = written > 0 ? .saved : .failed
            }
            await self.confirm(outcome)
            self.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === titleField {
            if let noteView = noteTextView, !noteView.isHidden {
                noteView.becomeFirstResponder()
            } else {
                textField.resignFirstResponder()
            }
            return false
        }
        if textField === tagInputField {
            commitTagInput()
            textField.resignFirstResponder()
            return false
        }
        return true
    }

    func textViewDidChange(_ textView: UITextView) {
        if textView === noteTextView {
            notePlaceholderLabel?.isHidden = !textView.text.isEmpty
        }
    }

    private func confirm(_ outcome: Outcome) async {
        let message: String
        let symbol: String
        let tint: UIColor
        let seconds: Double
        switch outcome {
        case .saved:
            (message, symbol, tint, seconds) = (Self.localized("saved", fallback: "Saved to PrivacyNotes"), "checkmark.circle.fill", .systemGreen, 0.9)
        case .tooLarge(let limit):
            let megabytes = String(max(1, limit / 1_000_000))
            let text = Self.localized("tooLarge", fallback: "Too large. Maximum is {{limit}} MB per file.").replacingOccurrences(of: "{{limit}}", with: megabytes)
            (message, symbol, tint, seconds) = (text, "exclamationmark.triangle.fill", .systemOrange, 2.2)
        case .failed:
            (message, symbol, tint, seconds) = (Self.localized("failed", fallback: "Could not save to PrivacyNotes"), "exclamationmark.circle.fill", .systemRed, 1.8)
        }
        let icon = UIImageView(image: UIImage(systemName: symbol))
        icon.tintColor = tint
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 44, weight: .semibold)
        let label = UILabel()
        label.text = message
        label.font = .preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.textAlignment = .center
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        stack.addArrangedSubview(icon)
        stack.addArrangedSubview(label)
        UIAccessibility.post(notification: .announcement, argument: message)
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    private static func localized(_ key: String, fallback: String) -> String {
        NSLocalizedString(key, value: fallback, comment: "")
    }

    private static func loneWebURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              let host = url.host,
              host.contains(".")
        else { return nil }
        return url
    }

    /// Downsampled EXIF-oriented thumbnail so a 48 MP photo never blows the
    /// share extension's ~120 MB memory ceiling.
    private static func makeThumbnail(from url: URL, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cgImage)
    }

    /// The signed-in account's per-file limit, which the app writes beside the
    /// inbox after each quota read (src/share_inbox.rs, "ShareLimit").
    private static func accountLimit(_ group: URL) -> Int {
        guard let text = try? String(contentsOf: group.appendingPathComponent("ShareLimit"), encoding: .utf8),
              let limit = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)), limit > 0
        else { return maxFileBytes }
        return min(limit, maxFileBytes)
    }

    /// Non-PIN organizer metadata written by the app while App Lock is off.
    private static func readCatalog(_ group: URL) -> ShareCatalog {
        let url = group.appendingPathComponent("ShareMeta", isDirectory: true).appendingPathComponent("ShareCatalog.json")
        guard let data = try? Data(contentsOf: url),
              let parsed = try? JSONDecoder().decode(ShareCatalog.self, from: data),
              parsed.v == 1
        else { return .empty }
        return parsed
    }

    private static func readLastPick(_ group: URL) -> String? {
        let url = group.appendingPathComponent("ShareMeta", isDirectory: true).appendingPathComponent("ShareLastPick")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return UUID(uuidString: trimmed) != nil ? trimmed : nil
    }

    private static func writeLastPick(_ id: String?, in group: URL) {
        let meta = group.appendingPathComponent("ShareMeta", isDirectory: true)
        let target = meta.appendingPathComponent("ShareLastPick")
        guard let id else {
            try? FileManager.default.removeItem(at: target)
            return
        }
        try? FileManager.default.createDirectory(at: meta, withIntermediateDirectories: true, attributes: protectedFolder)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var metaURL = meta
        try? metaURL.setResourceValues(excluded)
        if let data = id.data(using: .utf8) {
            try? data.write(to: target, options: [.atomic, .completeFileProtection])
        }
    }

    private static func prepareInbox() -> (group: URL, inbox: URL, limit: Int)? {
        guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        let inbox = group.appendingPathComponent("ShareInbox", isDirectory: true)
        let limit = accountLimit(group)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true, attributes: protectedFolder)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var inboxURL = inbox
        try? inboxURL.setResourceValues(excluded)
        return (group, inbox, limit)
    }

    private static func saveAllImmediate(providers: [NSItemProvider], itemText: String?, inbox: URL, limit: Int) async -> Outcome {
        var urls: [URL] = []
        var texts: [String] = []
        var files = 0
        var tooLarge = 0

        for provider in providers.prefix(maxFiles + 1) {
            if let url = await webURL(provider) {
                urls.append(url)
            } else if let text = await plainText(provider) {
                texts.append(text)
            } else if files < maxFiles, let type = fileType(provider) {
                switch await stageFile(provider, type: type, index: files, limit: limit, inbox: inbox) {
                case .staged(let staged):
                    let item: [String: Any] = ["kind": "file", "name": staged.name, "mime": staged.mime]
                    if finish(item, tmp: staged.tmp, id: staged.id, inbox: inbox) { files += 1 }
                case .tooLarge: tooLarge += 1
                case .failed: break
                }
            }
        }

        let shared = texts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        var written = files
        for url in urls {
            let title = itemText ?? (shared == url.absoluteString ? "" : shared)
            if write(["kind": "url", "url": url.absoluteString, "title": String(title.prefix(maxTextChars))], inbox: inbox) { written += 1 }
        }
        let note = shared.isEmpty && files == 0 ? (itemText ?? "") : shared
        if urls.isEmpty && !note.isEmpty {
            if write(["kind": "text", "text": String(note.prefix(maxTextChars))], inbox: inbox) { written += 1 }
        }
        if tooLarge > 0 { return .tooLarge(limit: limit) }
        return written > 0 ? .saved : .failed
    }

    private static func plainText(_ provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
              !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
              let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        else { return nil }
        if let text = item as? String { return text }
        if let data = item as? Data { return String(data: data, encoding: .utf8) }
        return nil
    }

    private static func webURL(_ provider: NSItemProvider) async -> URL? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
              !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
              let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier),
              let url = item as? URL,
              url.scheme == "http" || url.scheme == "https"
        else { return nil }
        return url
    }

    private static func fileType(_ provider: NSItemProvider) -> UTType? {
        provider.registeredContentTypes.first {
            $0.conforms(to: .data) && !$0.conforms(to: .plainText) && !$0.conforms(to: .url)
        }
    }

    /// Copies the provider's file into a protected `.tmp-<uuid>` folder without
    /// writing `item.json` yet, checking the original size against `limit`.
    private static func stageFile(_ provider: NSItemProvider, type: UTType, index: Int, limit: Int, inbox: URL) async -> StageResult {
        let id = UUID().uuidString
        let tmp = inbox.appendingPathComponent(".tmp-\(id)", isDirectory: true)
        var overLimit = false
        let copiedName: String?? = await withCheckedContinuation { done in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { source, _ in
                guard let source,
                      let size = try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                      size > 0
                else { done.resume(returning: nil); return }
                guard size <= limit else {
                    overLimit = true
                    done.resume(returning: nil)
                    return
                }
                do {
                    try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true, attributes: protectedFolder)
                    let payload = tmp.appendingPathComponent("payload")
                    try FileManager.default.copyItem(at: source, to: payload)
                    try protect(payload)
                    let own = source.lastPathComponent
                    done.resume(returning: .some(own.isEmpty ? nil : own))
                } catch {
                    done.resume(returning: nil)
                }
            }
        }
        guard let copiedName else {
            try? FileManager.default.removeItem(at: tmp)
            return overLimit ? .tooLarge : .failed
        }
        let ext = type.preferredFilenameExtension.map { ".\($0)" } ?? ""
        let name: String
        if let given = provider.suggestedName ?? copiedName {
            name = (given as NSString).pathExtension.isEmpty ? given + ext : given
        } else {
            let number = index == 0 ? "" : " \(index + 1)"
            name = Self.stamp.string(from: Date()) + number + ext
        }
        return .staged(StagedFile(id: id, tmp: tmp, name: name, mime: type.preferredMIMEType ?? ""))
    }

    private static func write(_ fields: [String: Any], inbox: URL) -> Bool {
        let id = UUID().uuidString
        let tmp = inbox.appendingPathComponent(".tmp-\(id)", isDirectory: true)
        guard (try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true, attributes: protectedFolder)) != nil else {
            return false
        }
        return finish(fields, tmp: tmp, id: id, inbox: inbox)
    }

    /// Writes item.json and renames the folder into place, so the app never
    /// sees an item half written.
    private static func finish(_ fields: [String: Any], tmp: URL, id: String, inbox: URL) -> Bool {
        var item = fields
        item["v"] = 1
        item["created"] = Int(Date().timeIntervalSince1970 * 1000)
        do {
            let json = try JSONSerialization.data(withJSONObject: item)
            try json.write(to: tmp.appendingPathComponent("item.json"), options: [.atomic, .completeFileProtection])
            try FileManager.default.moveItem(at: tmp, to: inbox.appendingPathComponent(id, isDirectory: true))
            return true
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            return false
        }
    }

    private static func protect(_ url: URL) throws {
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    }
}
