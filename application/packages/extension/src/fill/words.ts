/**
 * The words of the fill script: what a login form calls its fields, in the
 * languages people have logins in. Written in normal spelling; `vocab.ts`
 * folds and squashes each word once, the same way `text.ts` treats the text of
 * a field. `sub` words are found anywhere in the squashed text; `tok` words
 * must be whole tokens (every word of three characters or fewer in Latin
 * letters and digits, and longer words that hide inside other words).
 *
 * Our own list. `wordsChromium.ts` adds more languages for three of the roles.
 * Spec: docs/internal/plans/click-to-fill.md (section 4); docs/internal/plans/click-to-fill-words.md (sections 1 and 2)
 */
export interface Words {
  sub: string[];
  tok: string[];
}

export const PASSWORD: Words = {
  sub: [
    'password', 'passwd', 'passphrase', 'passcode', 'pswd',
    'passwort', 'kennwort',                       // de
    'mot de passe',                               // fr
    'contraseña', 'clave de acceso',              // es
    'contrasenya', 'paraula de pas',              // ca
    'senha', 'palavra-passe', 'palavra-chave',    // pt
    'wachtwoord', 'paswoord',                     // nl
    'hasło',                                      // pl
    'heslo',                                      // cs, sk
    'şifre', 'parola',                            // tr; parola also it, ro
    'lösenord',                                   // sv
    'adgangskode', 'kodeord',                     // da
    'passord',                                    // nb
    'salasana',                                   // fi
    'jelszó',                                     // hu
    'κωδικός πρόσβασης', 'συνθηματικό',           // el
    'пароль',                                     // ru, uk
    'كلمة المرور', 'كلمة السر', 'الرقم السري',     // ar
    'סיסמה', 'סיסמא',                             // he
    'パスワード', '暗証番号',                       // ja
    '비밀번호', '패스워드', '암호',                  // ko
    '密码', '密碼',                                // zh
    'รหัสผ่าน',                                   // th
    'kata sandi',                                 // id
    'mật khẩu',                                   // vi
    'पासवर्ड',                                    // hi
  ],
  tok: ['pass', 'pwd', 'pw', 'psw', 'mdp', 'clave', 'sandi', 'رمز'],
};

/** A password field that is not the current password. */
export const PASSWORD_NEW: Words = {
  sub: [
    'newpass', 'new password', 'create password', 'choose password', 'set password',
    'neues passwort', 'neues kennwort', 'passwort festlegen', 'passwort erstellen',
    'nouveau mot de passe', 'créer un mot de passe', 'choisir un mot de passe',
    'nuova password', 'crea password', 'scegli password',
    'nueva contraseña', 'crear contraseña', 'nova contrasenya',
    'nova senha', 'nova palavra-passe', 'criar senha',
    'nieuw wachtwoord', 'wachtwoord kiezen',
    'nowe hasło', 'utwórz hasło', 'ustaw hasło',
    'nové heslo', 'vytvořit heslo', 'vytvoriť heslo',
    'yeni şifre', 'şifre oluştur',
    'nytt lösenord', 'ny adgangskode', 'nytt passord', 'uusi salasana', 'új jelszó', 'parolă nouă',
    'νέος κωδικός',
    'новый пароль', 'придумайте пароль', 'новий пароль', 'створіть пароль',
    'كلمة مرور جديدة', 'סיסמה חדשה',
    '新しいパスワード', 'パスワードを設定', '새 비밀번호', '비밀번호 설정',
    '新密码', '新密碼', '设置密码', '設定密碼',
    'รหัสผ่านใหม่', 'kata sandi baru', 'mật khẩu mới', 'नया पासवर्ड',
  ],
  tok: ['new'],
};

export const PASSWORD_CONFIRM: Words = {
  sub: [
    'confirm', 'confirmation', 'repeat', 'retype', 're-enter', 'reenter', 'again',
    'wiederholen', 'bestätigen', 'erneut eingeben',
    'confirmer', 'répéter', 'ressaisir', 'saisir à nouveau',
    'conferma', 'ripeti', 'reinserisci',
    'confirmar', 'repetir', 'repite', 'vuelve a escribir', 'repeteix',
    'bevestig', 'herhaal', 'nogmaals',
    'potwierdź', 'powtórz', 'ponownie',
    'potvrdit', 'potvrdiť', 'zopakovat', 'zopakovať', 'znovu',
    'onayla', 'tekrar', 'yeniden gir',
    'bekräfta', 'upprepa', 'bekræft', 'gentag', 'bekreft', 'gjenta', 'vahvista', 'megerősít', 'confirmă',
    'επιβεβαίωση', 'επανάληψη',
    'подтвердите', 'повторите', 'ещё раз', 'підтвердіть', 'повторіть', 'ще раз',
    'تأكيد', 'أعد إدخال', 'אימות סיסמה', 'הקלד שוב',
    '確認', '再入力', 'もう一度', '확인', '재입력', '다시 입력',
    '确认', '再次输入', '再次輸入',
    'ยืนยัน', 'อีกครั้ง', 'konfirmasi', 'ulangi', 'xác nhận', 'nhập lại', 'पुष्टि',
  ],
  // A second password field named like the first one plus a mark.
  tok: ['2', 'bis', 'verify'],
};

export const PASSWORD_CURRENT: Words = {
  sub: [
    'current', 'existing', 'old password', 'oldpass',
    'aktuelles', 'derzeitiges', 'altes passwort',
    'actuel', 'ancien mot de passe',
    'attuale', 'vecchia password',
    'actual', 'contraseña anterior', 'atual', 'senha antiga',
    'huidig', 'oud wachtwoord',
    'obecne', 'aktualne', 'stare hasło',
    'aktuální', 'stávající', 'aktuálne', 'staré heslo',
    'mevcut', 'eski şifre',
    'nuvarande', 'nuværende', 'nåværende', 'nykyinen', 'jelenlegi', 'actuală',
    'τρέχων',
    'текущий', 'старый пароль', 'поточний', 'старий пароль',
    'الحالية', 'القديمة', 'נוכחית',
    '現在の', '現在のパスワード', '현재', '기존',
    '当前', '目前', '原密码', '舊密碼', '旧密码',
    'ปัจจุบัน', 'เดิม', 'saat ini', 'lama', 'hiện tại', 'वर्तमान',
  ],
  tok: ['old', 'cur'],
};

/** Level 1: says "username" outright. */
export const USERNAME: Words = {
  sub: [
    'username', 'user name', 'user id', 'userid', 'login id', 'loginid', 'login name', 'loginname',
    'sign-in name', 'screen name', 'account name', 'account id', 'account number', 'member id', 'member number',
    'customer id', 'customer number', 'client number', 'identifier', 'apple id', 'user principal',
    'benutzername', 'nutzername', 'benutzerkennung', 'anmeldename', 'kundennummer', 'zugangsnummer',
    "nom d'utilisateur", 'identifiant', 'pseudonyme', 'numéro client',
    'nome utente', 'codice utente', 'codice cliente',
    'nombre de usuario', 'número de cliente',
    "nom d'usuari",
    'nome de usuário', 'nome de utilizador', 'número de cliente',
    'gebruikersnaam', 'klantnummer',
    'nazwa użytkownika', 'identyfikator', 'numer klienta',
    'uživatelské jméno', 'přihlašovací jméno',
    'používateľské meno', 'prihlasovacie meno',
    'kullanıcı adı', 'müşteri numarası',
    'användarnamn', 'brugernavn', 'brukernavn', 'käyttäjätunnus', 'käyttäjänimi', 'felhasználónév', 'nume de utilizator',
    'όνομα χρήστη',
    'имя пользователя', 'логин', "ім'я користувача", 'логін',
    'اسم المستخدم', 'שם משתמש',
    'ユーザー名', 'ユーザ名', 'ユーザーid', 'ログインid', 'アカウント名', '会員番号',
    '사용자 이름', '사용자명', '아이디', '회원번호',
    '用户名', '用戶名', '使用者名稱', '帳號', '账号', '帐号', '會員編號',
    'ชื่อผู้ใช้', 'nama pengguna', 'tên đăng nhập', 'tên người dùng', 'उपयोगकर्ता नाम', 'यूज़रनेम',
  ],
  tok: ['pseudo', 'handle', 'nickname'],
};

/** Level 2: an email field is the username of most sites. */
export const EMAIL: Words = {
  sub: [
    'email', 'e-mail', 'emailaddress',
    'courriel', 'adresse électronique',
    'correo', 'correu', 'posta elettronica',
    'e-post', 'eposta', 'e-posta', 'sähköposti',
    'эл. почта', 'электронная почта', 'почта', 'имейл',
    'електронна пошта', 'пошта',
    'البريد الإلكتروني', 'الايميل', 'الإيميل',
    'אימייל', 'דוא"ל', 'מייל',
    'メールアドレス', 'メール', '이메일', '메일',
    '邮箱', '邮件', '電子郵件', '电子邮件', '電郵', '信箱',
    'อีเมล', 'surel', 'thư điện tử', 'ईमेल',
    'ηλεκτρονικό ταχυδρομείο',
  ],
  tok: ['mail'],
};

/** Level 3: says "user" or "account", not "username". */
export const USER: Words = {
  sub: [
    'benutzer', 'utilisateur', 'utente', 'usuario', 'usuari', 'usuário', 'utilizador', 'gebruiker',
    'użytkownik', 'uživatel', 'používateľ', 'kullanıcı', 'användare', 'bruger', 'bruker', 'käyttäjä',
    'felhasználó', 'utilizator', 'χρήστης', 'пользователь', 'користувач', 'المستخدم', 'משתמש',
    'ユーザー', '사용자', '用户', '用戶', '使用者', 'ผู้ใช้', 'pengguna', 'người dùng', 'उपयोगकर्ता',
    'account', 'konto', 'compte', 'cuenta', 'аккаунт', 'акаунт', 'حساب', 'アカウント', '계정', '账户', '帳戶',
  ],
  tok: ['user', 'conta', 'usr'],
};

/** Level 4: short names developers give the field. Developer text only. */
export const TECHNICAL: Words = {
  sub: ['loginfmt', 'signin', 'sign_in', 'logon', 'uname', 'ulogin', 'umail', 'member', 'customer', 'client'],
  tok: ['uid', 'login', 'id', 'acct', 'nick', 'ident'],
};

/** Never a username, unless USERNAME or EMAIL also matched. */
export const NOT_USERNAME: Words = {
  sub: [
    'first name', 'firstname', 'last name', 'lastname', 'full name', 'fullname', 'given name', 'family name',
    'surname', 'middle name', 'maiden', 'display name', 'company', 'organization', 'organisation', 'job title',
    'vorname', 'nachname', 'firma',
    'prénom', 'nom de famille', 'société',
    'cognome', 'ragione sociale',
    'apellido', 'empresa',
    'cognom', 'sobrenome', 'apelido',
    'voornaam', 'achternaam', 'bedrijf',
    'imię', 'nazwisko',
    'křestní jméno', 'příjmení', 'krstné meno', 'priezvisko',
    'soyad', 'förnamn', 'efternamn', 'fornavn', 'efternavn', 'etternavn', 'etunimi', 'sukunimi',
    'keresztnév', 'vezetéknév', 'prenume',
    'фамилия', 'отчество', 'прізвище',
    'الاسم الأول', 'اسم العائلة', 'שם פרטי', 'שם משפחה',
    '氏名', 'お名前', '姓名', '이름을', '성함',
    'address', 'street', 'city', 'postal', 'postcode', 'country', 'province',
    'adresse', 'straße', 'indirizzo', 'dirección', 'endereço', 'adres', 'адрес', 'адреса', '住所', '주소', '地址',
    'birthday', 'birthdate', 'date of birth', 'geburtsdatum', 'date de naissance',
    'coupon', 'promo', 'voucher', 'gift card', 'discount', 'gutschein', 'code promo', 'cupón', 'cupom',
    'comment', 'message', 'subject', 'website', 'homepage', 'amount', 'quantity', 'price',
    'security answer', 'secret answer', 'hint',
  ],
  tok: ['zip', 'dob', 'age', 'qty', 'url', 'iban', 'ssn', 'vat'],
};

/** One-time code, level 1: only a code from an authenticator app is meant. */
export const CODE: Words = {
  sub: [
    'totp', 'one-time', 'onetime', 'one time code', 'one time password', 'otp code', 'otpcode', 'otp input',
    'two-factor', 'twofactor', 'two factor', 'twofa', '2-step', '2step', 'two-step', 'twostep',
    'multi-factor', 'multifactor', 'mfa code', 'mfacode', 'second factor',
    'auth code', 'authcode', 'authentication code', 'authenticator', 'verification code', 'verificationcode',
    'verify code', 'security code', 'six-digit', '6-digit', '6 digit',
    'bestätigungscode', 'sicherheitscode', 'einmalcode', 'einmalpasswort', 'zwei-faktor', 'authentifizierungscode', 'verifizierungscode',
    'code de vérification', 'code de sécurité', "code d'authentification", 'code à usage unique', 'double authentification', 'deux facteurs', 'deux étapes',
    'codice di verifica', 'codice di sicurezza', 'codice otp', 'due fattori', 'due passaggi',
    'código de verificación', 'código de seguridad', 'código de autenticación', 'dos factores', 'doble factor', 'dos pasos',
    'codi de verificació', 'dos factors', 'dos passos',
    'código de verificação', 'código de segurança', 'código de autenticação', 'dois fatores', 'duas etapas', 'dois passos',
    'verificatiecode', 'beveiligingscode', 'authenticatiecode', 'tweestaps', 'twee stappen', 'tweefactor',
    'kod weryfikacyjny', 'kod jednorazowy', 'kod uwierzytelniający', 'kod z aplikacji', 'dwuetapow', 'dwuskładnikow',
    'ověřovací kód', 'jednorázový kód', 'dvoufázov', 'overovací kód', 'jednorazový kód', 'dvojfaktor',
    'doğrulama kodu', 'güvenlik kodu', 'tek kullanımlık', 'iki faktör', 'iki adım',
    'verifieringskod', 'säkerhetskod', 'engångskod', 'tvåfaktor', 'tvåsteg',
    'bekræftelseskode', 'engangskode', 'tofaktor', 'bekreftelseskode', 'vahvistuskoodi', 'kertakäyttö', 'kaksivaihei',
    'ellenőrző kód', 'hitelesítő kód', 'kétlépcsős', 'cod de verificare', 'cod de securitate',
    'κωδικός επαλήθευσης', 'κωδικός επιβεβαίωσης',
    'код подтверждения', 'код проверки', 'одноразовый код', 'код аутентификации', 'двухфакторн', 'код из приложения',
    'код підтвердження', 'одноразовий код', 'код автентифікації', 'двофакторн',
    'رمز التحقق', 'رمز التأكيد', 'كود التحقق', 'المصادقة الثنائية', 'رمز الأمان',
    'קוד אימות', 'אימות דו-שלבי',
    '認証コード', '確認コード', 'ワンタイムパスワード', '二段階認証', '2段階認証', '二要素認証', 'セキュリティコード',
    '인증 코드', '인증코드', '인증번호', '확인 코드', '일회용 비밀번호', '2단계 인증', '보안 코드',
    '验证码', '驗證碼', '动态密码', '動態密碼', '两步验证', '兩步驟驗證', '雙重驗證', '双重验证', '安全码', '一次性密碼', '一次性密码',
    'รหัสยืนยัน', 'รหัส otp', 'รหัสผ่านครั้งเดียว', 'สองขั้นตอน',
    'kode verifikasi', 'kode otp', 'mã xác minh', 'mã xác thực', 'सत्यापन कोड', 'ओटीपी',
  ],
  tok: ['otp', 'otc', 'mfa', 'tfa', '2fa'],
};

/** One-time code, level 2: used only when nothing better is on the page. */
export const CODE_WEAK: Words = {
  sub: ['challenge'],
  tok: ['code', 'pin', 'token', 'kod', 'código', 'codice', 'codi', 'код', 'コード', '코드', '代码', '代碼', 'รหัส', 'kode', 'mã'],
};

/** A code field that does not take an authenticator code. */
export const NOT_CODE: Words = {
  sub: [
    'backup', 'recovery', 'restore', 'wiederherstellung', 'récupération', 'recupero', 'recuperación', 'recuperação',
    'herstel', 'odzyskiwani', 'obnov', 'kurtarma', 'återställ', 'резервн', 'восстановлен', 'відновлен',
    'バックアップ', '復旧', '복구', '备用', '備用', 'สำรอง',
    'text message', 'texted', 'sent to', 'we sent', 'emailed', 'email code', 'e-mail-code', 'per sms', 'par sms',
    'resend', 'send code', 'erneut senden', 'renvoyer', 'reenviar', 'opnieuw verzenden', 'wyślij ponownie',
    'отправить', 'надіслати', '再送信', '재전송', '重新发送', '重新傳送',
    'captcha', 'coupon', 'promo', 'voucher', 'gift', 'discount', 'invite', 'invitation', 'referral',
    'postcode', 'postal code', 'zip code', 'area code', 'country code', 'dial code', 'bar code', 'barcode',
    'card', 'cartão', 'tarjeta', 'carte', 'karte',
    '图形', '圖形', '图片验证', '圖片驗證',
  ],
  tok: ['sms', 'zip', 'cvv', 'cvc', 'csc', 'qr'],
};

/** A search box. Removes the field from every role. */
export const SEARCH: Words = {
  sub: [
    'search', 'suche', 'suchen', 'recherche', 'rechercher', 'ricerca', 'buscar', 'búsqueda', 'cercar',
    'pesquisa', 'pesquisar', 'procurar', 'zoeken', 'szukaj', 'wyszukaj', 'hledat', 'vyhledat', 'hľadať',
    'arama', 'haku', 'keresés', 'căutare', 'αναζήτηση',
    'поиск', 'искать', 'найти', 'пошук', 'шукати', 'بحث', 'חיפוש', '検索', '검색', '搜索', '搜尋', 'ค้นหา', 'tìm kiếm',
  ],
  tok: ['q', 'query', 'find', 'cari', 'ara', 'sök', 'søg', 'søk'],
};

/** A payment card field. Removes the field from every role, and makes a
 *  "security code" in the same group a card code. */
export const CARD: Words = {
  sub: [
    'card number', 'cardnumber', 'cardholder', 'credit card', 'creditcard', 'expiry', 'expiration',
    'kartennummer', 'numéro de carte', 'numero di carta', 'número de tarjeta', 'número do cartão', 'kaartnummer',
  ],
  tok: ['cvv', 'cvc', 'csc', 'cvn', 'ccv'],
};

/** Captcha, newsletter and identity-number fields. Removes the field from every role. */
export const NEVER_OTHER: Words = {
  sub: [
    'captcha', 'securimage',
    'newsletter', 'subscribe', 'mailing list', 'abonnieren', "s'abonner", 'suscríbete', 'suscribirse', 'inscreva-se',
    'nieuwsbrief', 'biuletyn', 'zpravodaj', 'bülten', 'nyhetsbrev', 'nyhedsbrev', 'рассылк', 'розсилк',
    'メルマガ', '뉴스레터', '订阅', '訂閱',
    'social security',
  ],
  tok: ['ssn'],
};

/** Taken out of the text before SEARCH is tested: they hold a search word by accident. */
export const SEARCH_EXCEPT = ['research', 'researcher', 'recherche scientifique'];

/** Words of a form, a heading or a button that say "this is where you sign in". */
export const LOGIN_CONTEXT: Words = {
  sub: [
    'login', 'log in', 'logon', 'log on', 'sign in', 'signin', 'sign on', 'signon',
    'anmelden', 'anmeldung', 'einloggen',
    'connexion', 'se connecter', "s'identifier", 'identifiez-vous',
    'accedi', 'accesso',
    'iniciar sesión', 'inicia sesión', 'acceder', 'ingresar',
    'inicia la sessió', 'iniciar sessió', 'accedeix',
    'iniciar sessão', 'entrar', 'acessar', 'fazer login',
    'inloggen', 'aanmelden',
    'zaloguj', 'logowanie',
    'přihlásit', 'přihlášení', 'prihlásiť', 'prihlásenie',
    'giriş yap', 'oturum aç',
    'logga in', 'log ind', 'logg inn', 'kirjaudu', 'bejelentkezés', 'belépés', 'autentificare', 'conectare',
    'σύνδεση', 'είσοδος',
    'войти', 'вход', 'авторизация', 'увійти', 'вхід',
    'تسجيل الدخول', 'دخول', 'התחברות', 'כניסה',
    'ログイン', 'サインイン', '로그인', '登录', '登入', '登錄',
    'เข้าสู่ระบบ', 'ลงชื่อเข้าใช้', 'masuk', 'đăng nhập', 'लॉग इन', 'साइन इन',
  ],
  tok: [],
};

/** Words of a form, a heading or a button that say "make a new account". */
export const SIGNUP_CONTEXT: Words = {
  sub: [
    'register', 'registration', 'sign up', 'signup', 'create account', 'create an account', 'create your account',
    'new account', 'get started',
    'registrieren', 'registrierung', 'konto erstellen',
    'inscription', "s'inscrire", 'créer un compte', 'créer mon compte',
    'registrati', 'registrazione', 'crea account', 'crea un account', 'iscriviti',
    'registrarse', 'regístrate', 'crear cuenta', 'crea tu cuenta',
    "registra't", 'crea un compte',
    'registar', 'registrar', 'cadastro', 'cadastrar', 'cadastre-se', 'criar conta',
    'registreren', 'account aanmaken',
    'zarejestruj', 'rejestracja', 'załóż konto', 'utwórz konto',
    'registrace', 'registrovat', 'vytvořit účet', 'registrácia', 'registrovať', 'vytvoriť účet',
    'kayıt ol', 'üye ol', 'hesap oluştur',
    'registrera', 'skapa konto', 'opret konto', 'opprett konto', 'rekisteröidy', 'luo tili', 'regisztráció', 'înregistrare', 'creează cont',
    'εγγραφή',
    'регистрация', 'зарегистрироваться', 'создать аккаунт', 'реєстрація', 'зареєструватися', 'створити акаунт',
    'إنشاء حساب', 'تسجيل جديد', 'سجل الآن', 'הרשמה', 'יצירת חשבון',
    '新規登録', '会員登録', 'アカウント作成', 'アカウントを作成', '회원가입', '계정 만들기',
    '注册', '註冊', '创建账户', '建立帳戶',
    'สมัครสมาชิก', 'ลงทะเบียน', 'daftar', 'đăng ký', 'साइन अप', 'रजिस्टर',
  ],
  tok: ['join'],
};

/**
 * A wider set of languages for the roles that `wordsChromium.ts` does not
 * have. All are `sub` words; `vocab.ts` adds each array to the list of the
 * same name.
 */
export const WIDER = {
  PASSWORD: [
    'رمز عبور', 'گذرواژه', 'کلمه عبور',           // fa
    'پاس ورڈ',                                    // ur
    'পাসওয়ার্ড',                                   // bn
    'kata laluan',                                // ms
    'парола',                                     // bg
    'лозинка', 'lozinka', 'zaporka',              // sr, hr
    'geslo',                                      // sl
    'slaptažodis',                                // lt
    'parole',                                     // lv
    'parool', 'salasõna',                         // et
  ],
  PASSWORD_NEW: [
    'رمز عبور جدید', 'نیا پاس ورڈ', 'নতুন পাসওয়ার্ড', 'kata laluan baharu', 'kata laluan baru', 'bagong password',
    'нова парола', 'нова лозинка', 'nova lozinka', 'nova zaporka', 'novo geslo', 'naujas slaptažodis', 'jauna parole', 'uus parool',
  ],
  PASSWORD_CONFIRM: [
    'تکرار', 'تأیید رمز', 'تایید رمز', 'تصدیق کریں', 'নিশ্চিত', 'sahkan', 'kumpirmahin',
    'потвърдете', 'повторете', 'потврди', 'понови', 'potvrdi', 'ponovi', 'potrdi',
    'pakartokite', 'patvirtinkite', 'atkārtojiet', 'apstipriniet', 'korda parool', 'kinnita',
  ],
  USERNAME: [
    'نام کاربری', 'صارف نام', 'یوزر نیم', 'ব্যবহারকারীর নাম', 'ইউজারনেম', 'nama pengguna',
    'потребителско име', 'корисничко име', 'korisničko ime', 'uporabniško ime',
    'vartotojo vardas', 'naudotojo vardas', 'lietotājvārds', 'kasutajanimi',
  ],
  EMAIL: [
    'ایمیل', 'پست الکترونیک', 'ای میل', 'ইমেইল', 'ইমেল', 'e-mel', 'emel',
    'имейл', 'електронна поща', 'имејл', 'е-пошта', 'e-pošta', 'e-naslov', 'el. paštas', 'e-pasts', 'meiliaadress',
  ],
  CODE: [
    'کد تایید', 'کد تأیید', 'رمز یکبار مصرف', 'تایید دو مرحله', 'تصدیقی کوڈ',
    'যাচাইকরণ কোড', 'ভেরিফিকেশন কোড', 'kod pengesahan',
    'код за потвърждение', 'код за проверка', 'верификациони код', 'verifikacioni kod', 'kod za potvrdu',
    'verifikacijski kod', 'kontrolni kod', 'potrditvena koda', 'varnostna koda',
    'patvirtinimo kodas', 'verifikācijas kods', 'apstiprinājuma kods', 'kinnituskood', 'turvakood',
  ],
  LOGIN_CONTEXT: [
    'ورود', 'وارد شوید', 'لاگ ان', 'سائن ان', 'লগ ইন', 'লগইন', 'সাইন ইন', 'log masuk', 'mag-log in', 'mag-sign in',
    'вход', 'влизане', 'пријава', 'пријави се', 'prijava', 'prijavi se', 'prijavite se',
    'prisijungti', 'prisijungimas', 'pieteikties', 'pieslēgties', 'ielogoties', 'logi sisse', 'sisselogimine',
  ],
  SIGNUP_CONTEXT: [
    'ثبت نام', 'ایجاد حساب', 'سائن اپ', 'اکاؤنٹ بنائیں', 'সাইন আপ', 'নিবন্ধন', 'অ্যাকাউন্ট তৈরি',
    'daftar akaun', 'mag-sign up', 'gumawa ng account',
    'регистрация', 'създаване на профил', 'регистрација', 'registracija', 'napravi nalog', 'izradi račun', 'ustvari račun',
    'registruotis', 'sukurti paskyrą', 'reģistrācija', 'reģistrēties', 'izveidot kontu', 'registreeru', 'loo konto',
  ],
  SEARCH: [
    'جستجو', 'تلاش کریں', 'অনুসন্ধান', 'carian', 'maghanap', 'търсене', 'претрага', 'pretraga', 'pretraži', 'iskanje',
    'paieška', 'meklēt', 'otsing',
  ],
};
