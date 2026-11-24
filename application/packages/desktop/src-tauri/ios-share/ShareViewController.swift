import ImageIO
import UIKit
import UniformTypeIdentifiers

/// The iOS share extension: PrivacyNotes in the system share sheet.
///
/// It runs in its own process and cannot reach the app, and it never holds the
/// keys. It writes what it was given into the app group's inbox, and the app
/// takes it from there once the user has signed in and cleared the app lock,
/// which is where the item is encrypted like any other. Until then each file
/// carries complete data protection, so iOS keeps it encrypted while the phone
/// is locked, and the app deletes it as soon as it has taken it.
///
/// Links, text and non-image files save at once: a card shows a spinner, then
/// "Saved to PrivacyNotes", the size limit, or the failure text, and closes
/// itself. Photo-only shares show a compact compose sheet (Note | Files,
/// defaulting to Note, with an optional title and note text and a downsampled
/// thumbnail) so a user can create a titled photo note on the fly (#870).
/// Tapping Save still transitions into the confirmation card before closing.
/// All UI strings come from the web catalogs: the version script writes them
/// into the .lproj folders beside this file.
/// Spec: docs/internal/specs/share-into-app.md
final class ShareViewController: UIViewController, UITextFieldDelegate, UITextViewDelegate {
    private static let appGroup = "group.app.privacynotes"
    /// The largest per-file limit the app grants (the storage add-on); the app's
    /// own check names the lower limits to the user. src/share_inbox.rs holds the
    /// same cap.
    private static let maxFileBytes = 100 * 1000 * 1000
    /// The app's own caps on shared text and titles; past them, text is cut here.
    private static let maxTextChars = 500_000
    private static let maxShortChars = 1_000
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

    private let card = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private let stack = UIStackView()
    private var started = false

    // Compose sheet state for photo-only shares (#870).
    private var composeSheet: UIView?
    private var segmented: UISegmentedControl?
    private var titleField: UITextField?
    private var noteTextView: UITextView?
    private var notePlaceholderLabel: UILabel?
    private var fieldsContainer: UIStackView?
    private var filesSummaryLabel: UILabel?
    private var saveButton: UIButton?
    private var stagedPhotos: [StagedFile] = []
    private var stagedInbox: URL?
    private var stagedTooLarge = 0
    private var stagedLimit = maxFileBytes
    private var saving = false

    deinit {
        for file in stagedPhotos {
            try? FileManager.default.removeItem(at: file.tmp)
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)
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

        // Check whether this share is photo-only (1..maxFiles images, no web
        // links, no non-image files). Links, text and other files stay instant.
        var imageProviders: [(NSItemProvider, UTType)] = []
        var hasOtherContent = false
        var textProviders: [NSItemProvider] = []
        for provider in providers.prefix(Self.maxFiles + 1) {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            {
                hasOtherContent = true
                break
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
               !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            {
                textProviders.append(provider)
            } else if let type = Self.fileType(provider) {
                if type.conforms(to: .image), imageProviders.count < Self.maxFiles {
                    imageProviders.append((provider, type))
                } else {
                    hasOtherContent = true
                    break
                }
            }
        }

        if !hasOtherContent && !imageProviders.isEmpty {
            await preparePhotoCompose(
                imageProviders: imageProviders,
                textProviders: textProviders,
                itemText: itemText,
                inbox: inboxInfo.inbox,
                limit: inboxInfo.limit
            )
            return
        }

        let outcome = await Self.saveAllImmediate(
            providers: providers,
            itemText: itemText,
            inbox: inboxInfo.inbox,
            limit: inboxInfo.limit
        )
        await confirm(outcome)
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// Stages shared photos once (so the host app is only asked once and size
    /// limits are caught before the user types), builds a small downsampled
    /// thumbnail, and presents the Note | Files compose sheet.
    private func preparePhotoCompose(
        imageProviders: [(NSItemProvider, UTType)],
        textProviders: [NSItemProvider],
        itemText: String?,
        inbox: URL,
        limit: Int
    ) async {
        var staged: [StagedFile] = []
        var tooLarge = 0
        for (index, entry) in imageProviders.enumerated() {
            switch await Self.stageFile(entry.0, type: entry.1, index: index, limit: limit, inbox: inbox) {
            case .staged(let file): staged.append(file)
            case .tooLarge: tooLarge += 1
            case .failed: break
            }
        }
        guard let first = staged.first else {
            let outcome: Outcome = tooLarge > 0 ? .tooLarge(limit: limit) : .failed
            await confirm(outcome)
            extensionContext?.completeRequest(returningItems: nil)
            return
        }

        var initialTexts: [String] = []
        for provider in textProviders {
            if let text = await Self.plainText(provider) {
                initialTexts.append(text)
            }
        }
        let prefill = initialTexts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let initialNote = prefill.isEmpty ? (itemText ?? "") : prefill
        let thumb = Self.makeThumbnail(from: first.tmp.appendingPathComponent("payload"), maxPixelSize: 240)

        stagedPhotos = staged
        stagedInbox = inbox
        stagedTooLarge = tooLarge
        stagedLimit = limit
        showPhotoSheet(thumbnail: thumb, initialNote: initialNote)
    }

    private func showPhotoSheet(thumbnail: UIImage?, initialNote: String) {
        card.isHidden = true

        let sheet = UIView()
        sheet.backgroundColor = .systemBackground
        sheet.layer.cornerRadius = 20
        sheet.layer.cornerCurve = .continuous
        sheet.clipsToBounds = true
        sheet.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sheet)
        composeSheet = sheet

        // Tap outside the text fields dismisses the keyboard without discarding.
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

        // Segmented toggle: Note (default) | Files
        let seg = UISegmentedControl(items: [
            Self.localized("note", fallback: "Note"),
            Self.localized("files", fallback: "Files"),
        ])
        seg.selectedSegmentIndex = 0
        seg.addTarget(self, action: #selector(modeChanged), for: .valueChanged)
        seg.translatesAutoresizingMaskIntoConstraints = false
        segmented = seg

        // Note fields (Title + Note body)
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

        let noteView = UITextView()
        noteView.font = .preferredFont(forTextStyle: .body)
        noteView.adjustsFontForContentSizeCategory = true
        noteView.textColor = .label
        noteView.backgroundColor = .clear
        noteView.textContainerInset = UIEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        noteView.textContainer.lineFragmentPadding = 0
        noteView.text = initialNote
        noteView.delegate = self
        noteView.translatesAutoresizingMaskIntoConstraints = false
        noteView.heightAnchor.constraint(equalToConstant: 80).isActive = true
        noteTextView = noteView

        let placeholder = UILabel()
        placeholder.text = Self.localized("notePlaceholder", fallback: "Add a note...")
        placeholder.font = .preferredFont(forTextStyle: .body)
        placeholder.adjustsFontForContentSizeCategory = true
        placeholder.textColor = .placeholderText
        placeholder.isHidden = !initialNote.isEmpty
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        noteView.addSubview(placeholder)
        notePlaceholderLabel = placeholder
        NSLayoutConstraint.activate([
            placeholder.topAnchor.constraint(equalTo: noteView.topAnchor, constant: 6),
            placeholder.leadingAnchor.constraint(equalTo: noteView.leadingAnchor),
            placeholder.trailingAnchor.constraint(lessThanOrEqualTo: noteView.trailingAnchor),
        ])

        let fieldsStack = UIStackView(arrangedSubviews: [titleInput, fieldDivider, noteView])
        fieldsStack.axis = .vertical
        fieldsStack.spacing = 8
        fieldsStack.translatesAutoresizingMaskIntoConstraints = false
        fieldsContainer = fieldsStack

        // Thumbnail preview (76x76) with "+N" count badge when sharing multiple photos.
        let thumbBox = UIView()
        thumbBox.backgroundColor = .secondarySystemBackground
        thumbBox.layer.cornerRadius = 12
        thumbBox.layer.cornerCurve = .continuous
        thumbBox.layer.borderWidth = 1 / UIScreen.main.scale
        thumbBox.layer.borderColor = UIColor.separator.cgColor
        thumbBox.clipsToBounds = true
        thumbBox.translatesAutoresizingMaskIntoConstraints = false

        let thumbImg = UIImageView(image: thumbnail ?? UIImage(systemName: "photo"))
        thumbImg.contentMode = thumbnail != nil ? .scaleAspectFill : .scaleAspectFit
        thumbImg.tintColor = .secondaryLabel
        thumbImg.translatesAutoresizingMaskIntoConstraints = false
        thumbBox.addSubview(thumbImg)
        NSLayoutConstraint.activate([
            thumbBox.widthAnchor.constraint(equalToConstant: 76),
            thumbBox.heightAnchor.constraint(equalToConstant: 76),
            thumbImg.topAnchor.constraint(equalTo: thumbBox.topAnchor),
            thumbImg.bottomAnchor.constraint(equalTo: thumbBox.bottomAnchor),
            thumbImg.leadingAnchor.constraint(equalTo: thumbBox.leadingAnchor),
            thumbImg.trailingAnchor.constraint(equalTo: thumbBox.trailingAnchor),
        ])

        if stagedPhotos.count > 1 {
            let badge = UILabel()
            badge.text = "+\(stagedPhotos.count - 1)"
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

        // Caption shown in Files mode beside the thumbnail, and at the foot in Note mode.
        let summaryText: String
        if stagedPhotos.count == 1 {
            summaryText = stagedPhotos[0].name
        } else {
            summaryText = Self.localized("photoCount", fallback: "{{count}} photos")
                .replacingOccurrences(of: "{{count}}", with: String(stagedPhotos.count))
        }

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

        let bodyRow = UIStackView(arrangedSubviews: [leftStack, thumbBox])
        bodyRow.axis = .horizontal
        bodyRow.alignment = .top
        bodyRow.spacing = 12
        bodyRow.translatesAutoresizingMaskIntoConstraints = false

        let footDivider = UIView()
        footDivider.backgroundColor = .separator
        footDivider.translatesAutoresizingMaskIntoConstraints = false
        footDivider.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true

        let footLabel = UILabel()
        footLabel.text = summaryText
        footLabel.font = .preferredFont(forTextStyle: .footnote)
        footLabel.adjustsFontForContentSizeCategory = true
        footLabel.textColor = .secondaryLabel
        footLabel.lineBreakMode = .byTruncatingMiddle
        footLabel.translatesAutoresizingMaskIntoConstraints = false

        let contentStack = UIStackView(arrangedSubviews: [seg, bodyRow, footDivider, footLabel])
        contentStack.axis = .vertical
        contentStack.spacing = 12
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        sheet.addSubview(header)
        sheet.addSubview(headerDivider)
        sheet.addSubview(contentStack)

        let centerY = sheet.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        centerY.priority = .defaultLow

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
            sheet.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            sheet.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -12),
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

            contentStack.topAnchor.constraint(equalTo: headerDivider.bottomAnchor, constant: 14),
            contentStack.leadingAnchor.constraint(equalTo: sheet.leadingAnchor, constant: 16),
            contentStack.trailingAnchor.constraint(equalTo: sheet.trailingAnchor, constant: -16),
            contentStack.bottomAnchor.constraint(equalTo: sheet.bottomAnchor, constant: -14),
        ])

        titleInput.becomeFirstResponder()
    }

    @objc private func dismissKeyboard() {
        view.endEditing(true)
    }

    @objc private func modeChanged() {
        let isNote = (segmented?.selectedSegmentIndex ?? 0) == 0
        if !isNote {
            view.endEditing(true)
        }
        fieldsContainer?.isHidden = !isNote
        filesSummaryLabel?.isHidden = isNote
    }

    @objc private func cancelTapped() {
        guard !saving else { return }
        view.endEditing(true)
        let toDelete = stagedPhotos
        stagedPhotos = []
        for file in toDelete {
            try? FileManager.default.removeItem(at: file.tmp)
        }
        extensionContext?.completeRequest(returningItems: nil)
    }

    @objc private func saveTapped() {
        guard !saving, let inbox = stagedInbox else { return }
        saving = true
        saveButton?.isEnabled = false
        view.endEditing(true)

        let isNote = (segmented?.selectedSegmentIndex ?? 0) == 0
        let rawTitle = (titleField?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let rawText = (noteTextView?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let title = String(rawTitle.prefix(Self.maxShortChars))
        let text = String(rawText.prefix(Self.maxTextChars))
        let photos = stagedPhotos
        stagedPhotos = []
        let tooLarge = stagedTooLarge
        let limit = stagedLimit

        composeSheet?.isHidden = true
        card.isHidden = false

        Task {
            let group = UUID().uuidString
            var written = 0
            for photo in photos {
                var fields: [String: Any] = [
                    "kind": "file",
                    "name": photo.name,
                    "mime": photo.mime,
                ]
                if isNote {
                    fields["target"] = "note"
                    fields["group"] = group
                    if !title.isEmpty { fields["title"] = title }
                    if !text.isEmpty { fields["text"] = text }
                }
                if Self.finish(fields, tmp: photo.tmp, id: photo.id, inbox: inbox) {
                    written += 1
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
            noteTextView?.becomeFirstResponder()
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
    /// inbox after each quota read (src/share_inbox.rs, "ShareLimit"). Before the
    /// app has run, the largest limit it grants, and the app's own upload check
    /// names the lower ones.
    private static func accountLimit(_ group: URL) -> Int {
        guard let text = try? String(contentsOf: group.appendingPathComponent("ShareLimit"), encoding: .utf8),
              let limit = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)), limit > 0
        else { return maxFileBytes }
        return min(limit, maxFileBytes)
    }

    private static func prepareInbox() -> (inbox: URL, limit: Int)? {
        guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        let inbox = group.appendingPathComponent("ShareInbox", isDirectory: true)
        let limit = accountLimit(group)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true, attributes: protectedFolder)
        // Kept out of iCloud and computer backups of the phone, as Android keeps
        // the app's data out of its backups. The app sets the same mark at each
        // start (gen/apple/privacynotes_iOS/BackupExclusion.m).
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var inboxURL = inbox
        try? inboxURL.setResourceValues(excluded)
        return (inbox, limit)
    }

    private static func saveAllImmediate(providers: [NSItemProvider], itemText: String?, inbox: URL, limit: Int) async -> Outcome {
        var urls: [URL] = []
        var texts: [String] = []
        var files = 0
        var tooLarge = 0

        // The activation rule admits at most a link and ten files, so anything past
        // that is a sender ignoring it; it is not read at all.
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

        // A link keeps the page title; text becomes a note, or, with no text
        // attachment, the item's own text does.
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

    /// The type to read a file as: the first registered type that is data and
    /// not text, which the compose text already carries.
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
        // The copy's own name, when the sender gives no suggested one: Files and
        // Mail hand over a copy that keeps the original file name.
        let copiedName: String?? = await withCheckedContinuation { done in
            // The system deletes `source` when this handler returns, so the copy
            // happens inside it.
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
                    // A copy can carry the source's own class; set ours explicitly.
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
            // Photos gives no name. The time of the share reads the same in every
            // language, where a word such as "photo" would need translating; its
            // dots are not an extension, so the type's own is always added.
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
