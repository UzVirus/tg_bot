// telegram-payment-bot/index.js
const { Telegraf, Markup, session } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
require('dotenv').config();

const { t } = require('./i18n');

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(new LocalSession({ database: 'session.json' }).middleware());

// Файлы конфигурации
const USERS_FILE = path.join(__dirname, 'users.json');
const ADMIN_CONFIG_FILE = path.join(__dirname, 'admin-config.json');

// Загрузка конфигурации админов с обработкой ошибок
let adminConfig;
try {
  adminConfig = require(ADMIN_CONFIG_FILE);
} catch (error) {
  console.error('❌ Ошибка загрузки admin-config.json:', error.message);
  console.error('Убедитесь, что файл существует и содержит правильную структуру JSON');
  process.exit(1);
}

const { admins, cardNumber, mainAdminUsername } = adminConfig;

// Валидация конфигурации
if (!admins || !Array.isArray(admins) || admins.length === 0) {
  console.error('❌ Некорректная конфигурация: массив admins должен содержать ID администраторов');
  process.exit(1);
}

if (!cardNumber) {
  console.error('❌ Некорректная конфигурация: не указан номер карты (cardNumber)');
  process.exit(1);
}

if (!mainAdminUsername) {
  console.error('❌ Некорректная конфигурация: не указан username главного админа (mainAdminUsername)');
  process.exit(1);
}

// Кэш пользователей для оптимизации
let usersCache = null;
let lastUsersFileModified = 0;

// Асинхронные функции для работы с файлами
async function loadUsers() {
  try {
    // Проверяем, нужно ли обновить кэш
    if (fsSync.existsSync(USERS_FILE)) {
      const stats = await fs.stat(USERS_FILE);
      if (usersCache && stats.mtimeMs <= lastUsersFileModified) {
        return usersCache;
      }
      lastUsersFileModified = stats.mtimeMs;
    }

    if (!fsSync.existsSync(USERS_FILE)) {
      usersCache = [];
      return usersCache;
    }
    
    const data = await fs.readFile(USERS_FILE, 'utf8');
    usersCache = JSON.parse(data);
    return usersCache;
  } catch (error) {
    console.error('❌ Ошибка загрузки пользователей:', error);
    usersCache = [];
    return usersCache;
  }
}

async function saveUsers(users) {
  try {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
    usersCache = users;
    lastUsersFileModified = Date.now();
  } catch (error) {
    console.error('❌ Ошибка сохранения пользователей:', error);
    throw error;
  }
}

async function findUser(ctx) {
  const users = await loadUsers();
  return users.find(u => u.telegramId === ctx.from.id);
}

async function ensureUser(ctx) {
  let users = await loadUsers();
  let user = users.find(u => u.telegramId === ctx.from.id);
  
  if (!user) {
    user = {
      telegramId: ctx.from.id,
      firstName: ctx.from.first_name || '',
      lastName: ctx.from.last_name || '',
      username: ctx.from.username || '',
      phone: '',
      apartment: '',
      balance: 0,
      isPaid: false,
      payments: [],
      lang: ''
    };
    users.push(user);
    await saveUsers(users);
  }
  
  return user;
}

function mainMenu(lang) {
  return Markup.keyboard([
    [t(lang, 'btn_profile'), t(lang, 'btn_payment')],
    [t(lang, 'btn_history'), t(lang, 'btn_contact_admin')],
    [t(lang, 'btn_view_payments'), t(lang, 'btn_users')]
  ]).resize();
}

function apartmentKeyboard(lang, selected = []) {
  const buttons = [];

  for (let i = 1; i <= 90; i += 6) {
    const row = [];
    for (let j = i; j < i + 6 && j <= 90; j++) {
      const isSelected = selected.includes(j.toString());
      row.push(Markup.button.callback(
        isSelected ? `✅ ${j}` : `${j}`, 
        `apartment_${j}`
      ));
    }
    buttons.push(row);
  }

  buttons.push([
    Markup.button.callback(t(lang, 'done_n_but'), 'confirm_apartments'),
    Markup.button.callback(t(lang, 'clear_n_but'), 'clear_apartments')
  ]);

  return Markup.inlineKeyboard(buttons);
}

// Вспомогательная функция форматирования месяца
function formatMonth(monthIndex, year) {
  const m = (monthIndex + 1).toString().padStart(2, '0');
  return `${year}-${m}`;
}

// Инициализация сессии если она не существует
function ensureSession(ctx) {
  if (!ctx.session) {
    ctx.session = {};
  }
}

// Обработчик команды /start
bot.start(async (ctx) => {
  try {
    const user = await ensureUser(ctx);
    
    if (!user.lang) {
      return ctx.reply(t('ru', 'choose_lang'), 
        Markup.inlineKeyboard([
          [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
          [Markup.button.callback('🇺🇿 O\'zbekcha', 'lang_uz')]
        ])
      );
    }

    // Проверяем, завершена ли регистрация
    if (!user.phone) {
      // Пользователь не завершил регистрацию - запрашиваем телефон
      ensureSession(ctx);
      ctx.session.awaitingPhone = true;
      
      await ctx.reply(t(user.lang, 'welcome'), 
        Markup.keyboard([
          Markup.button.contactRequest(t(user.lang, 'send_phone_button'))
        ]).oneTime().resize()
      );
    } else if (!user.apartment) {
      // Есть телефон, но нет квартиры - продолжаем регистрацию
      ensureSession(ctx);
      ctx.session.awaitingPhone = false;
      ctx.session.selectingApartments = true;
      ctx.session.apartments = [];
      
      ctx.reply(t(user.lang, 'select_apartments'), apartmentKeyboard(user.lang));
    } else {
      // Регистрация завершена - показываем главное меню
      ctx.reply(t(user.lang, 'welcome_back'), mainMenu(user.lang));
    }
  } catch (error) {
    console.error('❌ Ошибка в обработчике /start:', error);
    ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

// Обработчик выбора языка (при первой регистрации)
bot.action(/lang_(ru|uz)/, async (ctx) => {
  try {
    const lang = ctx.match[1];
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.telegramId === ctx.from.id);
    
    if (userIndex === -1) return;

    users[userIndex].lang = lang;
    await saveUsers(users);

    // Сначала удаляем inline-клавиатуру из предыдущего сообщения
    await ctx.editMessageText(t(lang, 'lang_selected'));
    
    // Проверяем состояние регистрации пользователя
    const user = users[userIndex];
    
    if (!user.phone) {
      // Нет телефона - запрашиваем
      ensureSession(ctx);
      ctx.session.awaitingPhone = true;
      
      await ctx.reply(t(lang, 'welcome'), 
        Markup.keyboard([
          Markup.button.contactRequest(t(lang, 'send_phone_button'))
        ]).oneTime().resize()
      );
    } else if (!user.apartment) {
      // Есть телефон, но нет квартиры
      ensureSession(ctx);
      ctx.session.awaitingPhone = false;
      ctx.session.selectingApartments = true;
      ctx.session.apartments = [];
      
      await ctx.reply(t(lang, 'select_apartments'), apartmentKeyboard(lang));
    } else {
      // Регистрация завершена - показываем главное меню
      await ctx.reply(t(lang, 'welcome_back'), mainMenu(lang));
    }
    
  } catch (error) {
    console.error('❌ Ошибка в выборе языка:', error);
    
    // Fallback: отправляем новое сообщение без редактирования
    try {
      const lang = ctx.match[1];
      await ctx.reply(t(lang, 'welcome_back'), mainMenu(lang));
    } catch (fallbackError) {
      console.error('❌ Ошибка в fallback выбора языка:', fallbackError);
    }
  }
});

// Обработчик получения контакта
bot.on('contact', async (ctx) => {
  try {
    const user = await ensureUser(ctx);
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.telegramId === ctx.from.id);
    
    if (userIndex !== -1) {
      users[userIndex].phone = ctx.message.contact.phone_number;
      await saveUsers(users);
    }

    ensureSession(ctx);
    ctx.session.awaitingPhone = false;
    ctx.session.selectingApartments = true;
    ctx.session.apartments = [];
    
    ctx.reply(t(user.lang, 'select_apartments'), apartmentKeyboard(user.lang));
  } catch (error) {
    console.error('❌ Ошибка в обработчике контакта:', error);
  }
});

// Обновленный обработчик профиля с кнопкой изменения языка
bot.hears([/👤/, /Mening profilim/, /Мой профиль/], async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    const langDisplay = user.lang === 'ru' ? '🇷🇺 Русский' : '🇺🇿 O\'zbekcha';

    const profile = t(user.lang, 'profile_caption', {
      firstName: user.firstName || '—',
      lastName: user.lastName || '—',
      apartment: user.apartment || t(user.lang, 'not_specified'),
      phone: user.phone || t(user.lang, 'not_specified'),
      balance: user.balance ?? 0,
      language: langDisplay
    });

    ctx.reply(profile, Markup.inlineKeyboard([
      [Markup.button.callback(t(user.lang, 'text_edit_firstName'), 'edit_firstName')],
      [Markup.button.callback(t(user.lang, 'text_edit_lastName'), 'edit_lastName')],
      [Markup.button.callback(t(user.lang, 'text_edit_apartment'), 'edit_apartment')],
      [Markup.button.callback(t(user.lang, 'text_edit_phone'), 'edit_phone')],
      [Markup.button.callback(t(user.lang, 'text_edit_language'), 'edit_language')]
    ]));
  } catch (error) {
    console.error('❌ Ошибка в обработчике профиля:', error);
  }
});

// Новый обработчик изменения языка
bot.action('edit_language', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    const currentLang = user.lang === 'ru' ? '🇷🇺 Русский' : '🇺🇿 O\'zbekcha';
    
    await ctx.editMessageText(
      t(user.lang, 'select_new_language', { current: currentLang }),
      Markup.inlineKeyboard([
        [Markup.button.callback('🇷🇺 Русский', 'change_lang_ru')],
        [Markup.button.callback('🇺🇿 O\'zbekcha', 'change_lang_uz')],
        [Markup.button.callback(t(user.lang, 'btn_back'), 'back_to_profile')]
      ])
    );
  } catch (error) {
    console.error('❌ Ошибка в обработчике изменения языка:', error);
  }
});

// Обработчик смены языка
bot.action(/change_lang_(ru|uz)/, async (ctx) => {
  try {
    const newLang = ctx.match[1];
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.telegramId === ctx.from.id);
    
    if (userIndex === -1) return;

    const oldLang = users[userIndex].lang;
    
    if (oldLang === newLang) {
      await ctx.answerCbQuery(t(newLang, 'same_language_selected'));
      return;
    }

    users[userIndex].lang = newLang;
    await saveUsers(users);

    await ctx.answerCbQuery(t(newLang, 'language_changed_success'));
    
    // Обновляем профиль с новым языком
    const user = users[userIndex];
    const langDisplay = newLang === 'ru' ? '🇷🇺 Русский' : '🇺🇿 O\'zbekcha';

    const profile = t(newLang, 'profile_caption', {
      firstName: user.firstName || '—',
      lastName: user.lastName || '—',
      apartment: user.apartment || t(newLang, 'not_specified'),
      phone: user.phone || t(newLang, 'not_specified'),
      balance: user.balance ?? 0,
      language: langDisplay
    });

    await ctx.editMessageText(profile, Markup.inlineKeyboard([
      [Markup.button.callback(t(newLang, 'text_edit_firstName'), 'edit_firstName')],
      [Markup.button.callback(t(newLang, 'text_edit_lastName'), 'edit_lastName')],
      [Markup.button.callback(t(newLang, 'text_edit_apartment'), 'edit_apartment')],
      [Markup.button.callback(t(newLang, 'text_edit_phone'), 'edit_phone')],
      [Markup.button.callback(t(newLang, 'text_edit_language'), 'edit_language')]
    ]));

  } catch (error) {
    console.error('❌ Ошибка в смене языка:', error);
  }
});

// Обработчик возврата к профилю
bot.action('back_to_profile', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    const langDisplay = user.lang === 'ru' ? '🇷🇺 Русский' : '🇺🇿 O\'zbekcha';

    const profile = t(user.lang, 'profile_caption', {
      firstName: user.firstName || '—',
      lastName: user.lastName || '—',
      apartment: user.apartment || t(user.lang, 'not_specified'),
      phone: user.phone || t(user.lang, 'not_specified'),
      balance: user.balance ?? 0,
      language: langDisplay
    });

    await ctx.editMessageText(profile, Markup.inlineKeyboard([
      [Markup.button.callback(t(user.lang, 'text_edit_firstName'), 'edit_firstName')],
      [Markup.button.callback(t(user.lang, 'text_edit_lastName'), 'edit_lastName')],
      [Markup.button.callback(t(user.lang, 'text_edit_apartment'), 'edit_apartment')],
      [Markup.button.callback(t(user.lang, 'text_edit_phone'), 'edit_phone')],
      [Markup.button.callback(t(user.lang, 'text_edit_language'), 'edit_language')]
    ]));
  } catch (error) {
    console.error('❌ Ошибка в возврате к профилю:', error);
  }
});

// Обработчик связи с админом
bot.hears([/📞/, /bog'lanish/, /Связаться/], async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;
    
    ctx.reply(t(user.lang, 'text_admin_link') + ' @' + mainAdminUsername);
  } catch (error) {
    console.error('❌ Ошибка в обработчике связи с админом:', error);
  }
});

// Обработчик истории оплат
bot.hears([/🧾/, /tarixi/, /История/], async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    if (!user.payments || user.payments.length === 0) {
      return ctx.reply(t(user.lang, 'no_payments'));
    }

    const history = user.payments.map((p, i) => {
      const date = new Date(p.date);
      const formattedDate = date.toLocaleDateString(user.lang === 'uz' ? 'uz-UZ' : 'ru-RU');
      return `${i + 1}. Месяц: ${p.month}\nСумма: ${p.amount} ${user.lang === 'uz' ? 'so\'m' : 'сум'}\nДата: ${formattedDate}`;
    }).join('\n\n');

    ctx.reply(`${t(user.lang, 'btn_history')}\n\n${history}`);
  } catch (error) {
    console.error('❌ Ошибка в обработчике истории:', error);
  }
});

// Обработчик оплаты
bot.hears([/💸/, /To'lov/, /Оплата/], async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    const now = new Date();
    const year = now.getFullYear();

    const allMonths = [];
    for (let m = 0; m < 12; m++) {
      allMonths.push(formatMonth(m, year));
    }

    const buttons = [];
    for (let i = 0; i < allMonths.length; i += 3) {
      const row = allMonths.slice(i, i + 3).map(month =>
        Markup.button.callback(`📅 ${month}`, `select_month_${month}`)
      );
      buttons.push(row);
    }

    ctx.reply(t(user.lang, 'select_payment_month', { year }), Markup.inlineKeyboard(buttons));
  } catch (error) {
    console.error('❌ Ошибка в обработчике оплаты:', error);
  }
});

// Обработчик просмотра всех оплат
bot.hears([/📊/, /ko'rish/, /Посмотреть/], async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    const users = await loadUsers();
    const monthMap = {};

    users.forEach(u => {
      if (u.payments && u.payments.length > 0) {
        u.payments.forEach(p => {
          if (!monthMap[p.month]) monthMap[p.month] = [];
          monthMap[p.month].push({
            name: `${u.firstName} ${u.lastName}`,
            apartment: u.apartment || '-',
            amount: p.amount,
            date: new Date(p.date).toLocaleDateString(user.lang === 'uz' ? 'uz-UZ' : 'ru-RU')
          });
        });
      }
    });

    const sortedMonths = Object.keys(monthMap).sort();

    if (sortedMonths.length === 0) {
      return ctx.reply(t(user.lang, 'text_not_payments'));
    }

    let response = t(user.lang, 'text_all_payments');
    const currency = user.lang === 'uz' ? 'so\'m' : 'сум';

    sortedMonths.forEach(month => {
      response += `📅 ${month}:\n`;
      const monthTotal = monthMap[month].reduce((sum, p) => sum + p.amount, 0);

      monthMap[month].forEach((p, i) => {
        response += `${i + 1}. ${p.name} (кв. ${p.apartment}) — ${p.amount} ${currency} (${p.date})\n`;
      });

      response += `🧮 ${user.lang === 'uz' ? 'Jami' : 'Всего за месяц'}: ${monthTotal} ${currency}\n\n`;
    });

    ctx.reply(response);
  } catch (error) {
    console.error('❌ Ошибка в обработчике просмотра оплат:', error);
  }
});

// Обработчик списка пользователей
bot.hears([/👥/, /Foydalanuvchilar/, /Пользователи/], async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    if (!admins.includes(ctx.from.id)) {
      return ctx.reply(t(user.lang, 'users_only_admin'));
    }

    const users = await loadUsers();

    if (users.length === 0) {
      return ctx.reply(t(user.lang, 'no_users'));
    }

    let message = t(user.lang, 'list_users');
    const currency = user.lang === 'uz' ? 'so\'m' : 'сум';

    users.forEach((u, i) => {
      message += `${i + 1}. ${u.firstName} ${u.lastName} — кв. ${u.apartment || '—'}\n` +
                 `📞 ${u.phone || '—'} | 💰 ${u.balance} ${currency}\n\n`;
    });

    ctx.reply(message);
  } catch (error) {
    console.error('❌ Ошибка в обработчике списка пользователей:', error);
  }
});

// Обработчик выбора месяца
bot.action(/select_month_(\d{4}-\d{2})/, async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    const month = ctx.match[1];
    ensureSession(ctx);
    ctx.session.paymentMonth = month;

    const currency = user.lang === 'uz' ? 'so\'m' : 'сум';
    const customText = user.lang === 'uz' ? 'Boshqa summa' : 'Другая сумма';

    ctx.reply(`${user.lang === 'uz' ? 'Siz tanladingiz' : 'Вы выбрали месяц'}: ${month}\n${user.lang === 'uz' ? 'Endi summani tanlang' : 'Теперь выберите сумму'}:`, 
      Markup.inlineKeyboard([
        [Markup.button.callback(`50 000 ${currency}`, 'pay_50000')],
        [Markup.button.callback(`100 000 ${currency}`, 'pay_100000')],
        [Markup.button.callback(customText, 'pay_custom')]
      ])
    );
  } catch (error) {
    console.error('❌ Ошибка в выборе месяца:', error);
  }
});

// Обработчик оплаты фиксированной суммы
bot.action(/pay_(\d+)/, async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    if (!ctx.session?.paymentMonth) {
      return ctx.reply(t(user.lang, 'select_month_first'));
    }

    const amount = ctx.match[1];
    ensureSession(ctx);
    ctx.session.paymentAmount = parseInt(amount);
    ctx.session.customPay = false;

    const currency = user.lang === 'uz' ? 'so\'m' : 'сум';
    ctx.reply(t(user.lang, 'screenshot_prompt', { 
      amount: `${amount} ${currency}`, 
      card: cardNumber 
    }));
  } catch (error) {
    console.error('❌ Ошибка в обработчике фиксированной оплаты:', error);
  }
});

// Обработчик пользовательской суммы
bot.action('pay_custom', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    if (!ctx.session?.paymentMonth) {
      return ctx.reply(t(user.lang, 'select_month_first'));
    }

    ensureSession(ctx);
    ctx.session.customPay = true;
    ctx.reply(t(user.lang, 'custom_amount_prompt'));
  } catch (error) {
    console.error('❌ Ошибка в обработчике пользовательской суммы:', error);
  }
});

// Обработчик фотографий
bot.on('photo', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    const amount = ctx.session?.paymentAmount || 0;
    const month = ctx.session?.paymentMonth;

    if (!amount || !month) {
      return ctx.reply(user.lang === 'uz' ? 
        'Avval oy va to\'lov summasini tanlang.' : 
        'Сначала выберите месяц и сумму оплаты.'
      );
    }

    const currency = user.lang === 'uz' ? 'so\'m' : 'сум';
    const caption = `${user.lang === 'uz' ? 'Foydalanuvchi' : 'Пользователь'}: ${user.firstName} ${user.lastName} (@${user.username})\n${user.lang === 'uz' ? 'Summa' : 'Сумма'}: ${amount} ${currency}\n${user.lang === 'uz' ? 'Oy' : 'Месяц'}: ${month}`;

    // Отправка фото всем админам
    const sendPromises = admins.map(adminId => 
      bot.telegram.sendPhoto(adminId, ctx.message.photo.at(-1).file_id, {
        caption,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Подтвердить', callback_data: `confirm_${user.telegramId}_${amount}_${month}` },
            { text: '❌ Отклонить', callback_data: `decline_${user.telegramId}` }
          ]]
        }
      }).catch(err => console.error(`❌ Ошибка отправки админу ${adminId}:`, err))
    );

    await Promise.allSettled(sendPromises);
    ctx.reply(t(user.lang, 'screenshot_sent'));
  } catch (error) {
    console.error('❌ Ошибка в обработчике фото:', error);
  }
});

// Обработчик подтверждения оплаты
bot.action(/confirm_(\d+)_(\d+)_(\d{4}-\d{2})/, async (ctx) => {
  try {
    const telegramId = parseInt(ctx.match[1]);
    const amount = parseInt(ctx.match[2]);
    const month = ctx.match[3];

    let users = await loadUsers();
    const userIndex = users.findIndex(u => u.telegramId === telegramId);
    
    if (userIndex === -1) return ctx.reply('Пользователь не найден');

    users[userIndex].balance += amount;
    users[userIndex].isPaid = true;
    users[userIndex].payments.push({ 
      month, 
      amount, 
      date: new Date().toISOString() 
    });

    await saveUsers(users);

    const user = users[userIndex];
    const currency = user.lang === 'uz' ? 'so\'m' : 'сум';
    
    bot.telegram.sendMessage(telegramId, 
      t(user.lang, 'confirm_success', { 
        amount: `${amount} ${currency}`, 
        month 
      })
    );
    
    ctx.reply(t(user.lang, 'confirm_done'));
  } catch (error) {
    console.error('❌ Ошибка в подтверждении оплаты:', error);
  }
});

// Обработчик отклонения оплаты
bot.action(/decline_(\d+)/, async (ctx) => {
  try {
    const telegramId = parseInt(ctx.match[1]);
    const users = await loadUsers();
    const user = users.find(u => u.telegramId === telegramId);
    
    bot.telegram.sendMessage(telegramId, 
      t(user?.lang || 'ru', 'decline_message', { admin: mainAdminUsername })
    );
    
    ctx.reply(t(user?.lang || 'ru', 'decline_done'));
  } catch (error) {
    console.error('❌ Ошибка в отклонении оплаты:', error);
  }
});

// Обработчики редактирования профиля
bot.action('edit_firstName', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    ensureSession(ctx);
    ctx.session.editingField = 'firstName';
    ctx.reply(t(user.lang, 'edit_first_name'));
  } catch (error) {
    console.error('❌ Ошибка в редактировании имени:', error);
  }
});

bot.action('edit_lastName', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    ensureSession(ctx);
    ctx.session.editingField = 'lastName';
    ctx.reply(t(user.lang, 'edit_last_name'));
  } catch (error) {
    console.error('❌ Ошибка в редактировании фамилии:', error);
  }
});

bot.action('edit_apartment', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    const selected = user?.apartment?.split(',').map(a => a.trim()) || [];

    ensureSession(ctx);
    ctx.session.selectingApartments = true;
    ctx.session.apartments = selected;

    ctx.editMessageText(t(user.lang, 'edit_apartment'), 
      apartmentKeyboard(user.lang, selected)
    );
  } catch (error) {
    console.error('❌ Ошибка в редактировании квартиры:', error);
  }
});

bot.action('edit_phone', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    ensureSession(ctx);
    ctx.session.editingField = 'phone';
    ctx.reply(t(user.lang, 'edit_phone'));
  } catch (error) {
    console.error('❌ Ошибка в редактировании телефона:', error);
  }
});

// Обработчик выбора квартиры
bot.action(/apartment_(\d+)/, async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user || !ctx.session?.selectingApartments) return;

    const apt = ctx.match[1];
    if (!ctx.session.apartments) ctx.session.apartments = [];

    if (ctx.session.apartments.includes(apt)) {
      ctx.session.apartments = ctx.session.apartments.filter(a => a !== apt);
    } else {
      ctx.session.apartments.push(apt);
    }
    
    ctx.editMessageReplyMarkup(
      apartmentKeyboard(user.lang, ctx.session.apartments).reply_markup
    );
  } catch (error) {
    console.error('❌ Ошибка в выборе квартиры:', error);
  }
});

// Обработчик подтверждения квартир
bot.action('confirm_apartments', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    if (!ctx.session?.apartments || ctx.session.apartments.length === 0) {
      return ctx.answerCbQuery(t(user.lang, 'confirm_apartment_empty'));
    }

    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.telegramId === ctx.from.id);
    
    if (userIndex !== -1) {
      users[userIndex].apartment = ctx.session.apartments.join(', ');
      await saveUsers(users);
    }

    ctx.session.selectingApartments = false;
    ctx.session.apartments = [];
    
    ctx.editMessageText(t(user.lang, 'registration_complete'));
    ctx.reply(t(user.lang, 'menu_hint'), mainMenu(user.lang));
  } catch (error) {
    console.error('❌ Ошибка в подтверждении квартир:', error);
  }
});

// Обработчик очистки квартир
bot.action('clear_apartments', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    ensureSession(ctx);
    ctx.session.apartments = [];
    ctx.editMessageReplyMarkup(apartmentKeyboard(user.lang).reply_markup);
  } catch (error) {
    console.error('❌ Ошибка в очистке квартир:', error);
  }
});

// Обработчик текстовых сообщений
bot.on('text', async (ctx) => {
  try {
    const user = await findUser(ctx);
    if (!user) return;

    // Ввод кастомной суммы
    if (ctx.session?.customPay) {
      const amount = parseInt(ctx.message.text);
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply(t(user.lang, 'invalid_amount'));
      }
      ctx.session.paymentAmount = amount;
      ctx.session.customPay = false;
      const currency = user.lang === 'uz' ? 'so\'m' : 'сум';
      return ctx.reply(t(user.lang, 'screenshot_prompt', { 
        amount: `${amount} ${currency}`, 
        card: cardNumber 
      }));
    }

    // Обработка редактирования профиля
    if (ctx.session?.editingField) {
      const field = ctx.session.editingField;
      const users = await loadUsers();
      const userIndex = users.findIndex(u => u.telegramId === ctx.from.id);
      
      if (userIndex !== -1) {
        users[userIndex][field] = ctx.message.text;
        await saveUsers(users);
        ctx.reply(t(user.lang, 'update_success'), mainMenu(user.lang));
        // Вывести меню заново
      }
      ctx.session.editingField = null;
      return;
    }
  
    // Все прочие сообщения
    ctx.reply(t(user.lang, 'unknown_command'), mainMenu(user.lang));
  } catch (error) {
    console.error('❌ Ошибка в обработчике текста:', error);
  }
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error('❌ Критическая ошибка бота:', err);
  
  try {
    ctx.reply('Произошла ошибка. Пожалуйста, попробуйте позже или обратитесь к администратору.');
  } catch (replyError) {
    console.error('❌ Не удалось отправить сообщение об ошибке:', replyError);
  }
});

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 Получен сигнал SIGINT. Завершение работы бота...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 Получен сигнал SIGTERM. Завершение работы бота...');
  bot.stop('SIGTERM');
});

// Запуск бота
bot.launch().then(() => {
  console.log('🚀 Бот успешно запущен!');
}).catch((error) => {
  console.error('❌ Ошибка запуска бота:', error);
  process.exit(1);
});

console.log('⚡ Telegram Payment Bot запущен...');