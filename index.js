// telegram-payment-bot/index.js

const { Telegraf, Markup, session } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(new LocalSession({ database: 'session.json' }).middleware());

const USERS_FILE = path.join(__dirname, 'users.json');
const ADMIN_CONFIG_FILE = path.join(__dirname, 'admin-config.json');

const admins = require(ADMIN_CONFIG_FILE).admins;
const cardNumber = require(ADMIN_CONFIG_FILE).cardNumber;
const mainAdminUsername = require(ADMIN_CONFIG_FILE).mainAdminUsername;

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function findUser(ctx) {
  const users = loadUsers();
  return users.find(u => u.telegramId === ctx.from.id);
}

function ensureUser(ctx) {
  let users = loadUsers();
  let user = users.find(u => u.telegramId === ctx.from.id);
  if (!user) {
    user = {
      telegramId: ctx.from.id,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name || '',
      username: ctx.from.username || '',
      phone: '',
      apartment: '',
      balance: 0,
      isPaid: false,
      payments: []
    };
    users.push(user);
    saveUsers(users);
  }
  return user;
}

function mainMenu() {
  return Markup.keyboard([
    ['👤 Мой профиль', '💸 Оплата'],
    ['🧾 История оплат', '📞 Связаться с админом'],
    ['📊 Посмотреть оплаты'] // новая кнопка
  ]).resize();
}

bot.start(async ctx => {
  const user = ensureUser(ctx);
  ctx.session.awaitingPhone = true;
  await ctx.reply('Добро пожаловать! Пожалуйста, отправьте ваш номер телефона', Markup.keyboard([
    Markup.button.contactRequest('📱 Отправить номер телефона')
  ]).oneTime().resize());
});

bot.on('contact', ctx => {
  const user = ensureUser(ctx);
  const users = loadUsers();
  const index = users.findIndex(u => u.telegramId === ctx.from.id);
  users[index].phone = ctx.message.contact.phone_number;
  saveUsers(users);

  ctx.session.awaitingPhone = false;
  ctx.session.selectingApartments = true;
  ctx.session.apartments = [];

  ctx.reply('📋 Выберите один или несколько номеров квартир:', apartmentKeyboard());
});

// 👤 Мой профиль
bot.hears('👤 Мой профиль', ctx => {
  const user = findUser(ctx);
  if (!user) return;

  const profile = `👤 Ваш профиль:\n\n` +
    `Имя: ${user.firstName}\n` +
    `Фамилия: ${user.lastName}\n` +
    `Квартира: ${user.apartment || 'не указана'}\n` +
    `Телефон: ${user.phone || 'не указан'}\n` +
    `Баланс: ${user.balance} сум`;

  ctx.reply(profile, Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить имя', 'edit_firstName')],
    [Markup.button.callback('✏️ Изменить фамилию', 'edit_lastName')],
    [Markup.button.callback('🏢 Изменить квартиру', 'edit_apartment')],
    [Markup.button.callback('📞 Изменить телефон', 'edit_phone')]
  ]));
});

// 📞 Связаться с админом
bot.hears('📞 Связаться с админом', ctx => {
  ctx.reply(`Для связи с администратором: ${mainAdminUsername}`);
});

// 🧾 История оплат
bot.hears('🧾 История оплат', ctx => {
  const user = findUser(ctx);
  if (!user || !user.payments || user.payments.length === 0) {
    return ctx.reply('История оплат пуста.');
  }

  const history = user.payments.map((p, i) =>
    `${i + 1}. Месяц: ${p.month}\nСумма: ${p.amount} сум\nДата: ${new Date(p.date).toLocaleString('ru-RU')}`
  ).join('\n\n');

  ctx.reply(`📜 История оплат:\n\n${history}`);
});

// 💸 Оплата
bot.hears('💸 Оплата', ctx => {
  ctx.reply('Выберите сумму:', Markup.inlineKeyboard([
    [Markup.button.callback('50 000', 'pay_50000')],
    [Markup.button.callback('100 000', 'pay_100000')],
    [Markup.button.callback('Другая сумма', 'pay_custom')]
  ]));
});

// Оплата фиксированной суммы
bot.action(/pay_(\d+)/, ctx => {
  const amount = ctx.match[1];
  ctx.session.paymentAmount = parseInt(amount);
  ctx.session.customPay = false;
  ctx.reply(`Переведите ${amount} сум на карту: ${cardNumber}\nЗатем отправьте скриншот перевода.`);
});

// Другая сумма
bot.action('pay_custom', ctx => {
  ctx.session.customPay = true;
  ctx.reply('Введите нужную сумму:');
});

// Фото со скрином
bot.on('photo', ctx => {
  const user = findUser(ctx);
  const amount = ctx.session?.paymentAmount || 0;
  if (!amount) return ctx.reply('Сначала выберите сумму.');

  admins.forEach(adminId => {
    bot.telegram.sendPhoto(adminId, ctx.message.photo.at(-1).file_id, {
      caption: `Пользователь: ${user.firstName} ${user.lastName} (@${user.username})\nСумма: ${amount}`,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Подтвердить', callback_data: `confirm_${user.telegramId}_${amount}` },
          { text: '❌ Отклонить', callback_data: `decline_${user.telegramId}` }
        ]]
      }
    });
  });
  ctx.reply('Скриншот отправлен на проверку администраторам.');
});

// Подтвердить оплату
bot.action(/confirm_(\d+)_(\d+)/, ctx => {
  const telegramId = parseInt(ctx.match[1]);
  const amount = parseInt(ctx.match[2]);
  let users = loadUsers();
  const user = users.find(u => u.telegramId === telegramId);
  if (!user) return ctx.reply('Пользователь не найден');
  user.balance += amount;
  user.isPaid = true;
  user.payments.push({ month: new Date().toISOString().slice(0, 7), amount, date: new Date().toISOString() });
  saveUsers(users);
  bot.telegram.sendMessage(telegramId, `✅ Оплата на сумму ${amount} подтверждена. Баланс обновлён.`);
  ctx.reply('Оплата подтверждена.');
});

// Отклонить оплату
bot.action(/decline_(\d+)/, ctx => {
  const telegramId = parseInt(ctx.match[1]);
  bot.telegram.sendMessage(telegramId, `❌ Оплата отклонена. Свяжитесь с админом: ${mainAdminUsername}`);
  ctx.reply('Оплата отклонена.');
});

bot.action('edit_firstName', ctx => {
  ctx.session.editingField = 'firstName';
  ctx.reply('Введите новое Имя:');
});

bot.action('edit_lastName', ctx => {
  ctx.session.editingField = 'lastName';
  ctx.reply('Введите новую фамилию:');
});

bot.action('edit_apartment', ctx => {
  const user = findUser(ctx);
  const selected = user?.apartment?.split(',').map(a => a.trim()) || [];

  ctx.session.selectingApartments = true;
  ctx.session.apartments = selected;

  ctx.editMessageText('Выберите новые номера квартир:', apartmentKeyboard(selected));
});

bot.action('edit_phone', ctx => {
  ctx.session.editingField = 'phone';
  ctx.reply('Введите новый номер телефона:');
});

function getTakenApartments(currentUserId) {
  const users = loadUsers();
  const taken = [];

  users.forEach(user => {
    if (user.telegramId !== currentUserId && user.apartment) {
      user.apartment.split(',').forEach(a => taken.push(a.trim()));
    }
  });

  return taken;
}

function apartmentKeyboard(selected = []) {
  const buttons = [];

  for (let i = 1; i <= 90; i += 6) {
    const row = [];
    for (let j = i; j < i + 6 && j <= 90; j++) {
      const isSelected = selected.includes(j.toString());
      row.push(Markup.button.callback(isSelected ? `✅ ${j}` : `${j}`, `apartment_${j}`));
    }
    buttons.push(row);
  }

  buttons.push([
    Markup.button.callback('✅ Подтвердить', 'confirm_apartments'),
    Markup.button.callback('❌ Очистить', 'clear_apartments')
  ]);

  return Markup.inlineKeyboard(buttons);
}

bot.action(/apartment_(\d+)/, ctx => {
  if (!ctx.session.selectingApartments) return;

  const apt = ctx.match[1];
  ctx.session.apartments = ctx.session.apartments || [];

  if (ctx.session.apartments.includes(apt)) {
    ctx.session.apartments = ctx.session.apartments.filter(a => a !== apt);
  } else {
    ctx.session.apartments.push(apt);
  }

  ctx.editMessageReplyMarkup(apartmentKeyboard(ctx.session.apartments).reply_markup);
});

bot.action('confirm_apartments', ctx => {
  if (!ctx.session.apartments || ctx.session.apartments.length === 0) {
    return ctx.answerCbQuery('Сначала выберите хотя бы одну квартиру');
  }

  const users = loadUsers();
  const index = users.findIndex(u => u.telegramId === ctx.from.id);
  users[index].apartment = ctx.session.apartments.join(', ');
  saveUsers(users);

  ctx.session.selectingApartments = false;
  ctx.session.apartments = [];

  ctx.editMessageText('✅ Регистрация завершена! Квартиры сохранены.');
  ctx.reply('Вы можете использовать меню ниже.', mainMenu());
});

bot.action('clear_apartments', ctx => {
  ctx.session.apartments = [];
  ctx.editMessageReplyMarkup(apartmentKeyboard().reply_markup);
});

bot.hears('📊 Посмотреть оплаты', ctx => {
  const users = loadUsers();
  const currentMonth = new Date().toISOString().slice(0, 7); // Например, "2025-07"
  let response = `📊 Оплаты за ${currentMonth}:\n\n`;

  const payers = users.filter(u =>
    u.payments?.some(p => p.month === currentMonth)
  );

  if (payers.length === 0) {
    return ctx.reply('❗ В этом месяце пока никто не оплатил.');
  }

  payers.forEach((u, i) => {
    const payments = u.payments.filter(p => p.month === currentMonth);
    const total = payments.reduce((sum, p) => sum + p.amount, 0);
    response += `${i + 1}. ${u.firstName} ${u.lastName} (${u.apartment || '-'}) — ${total} сум\n`;
  });

  ctx.reply(response);
});


// ОБРАБОТКА ВВОДА ТЕКСТА (только в рамках регистрации или ручного ввода суммы)
bot.on('text', ctx => {
  const user = findUser(ctx);
  if (!user) return;


  // Ввод кастомной суммы
  if (ctx.session.customPay) {
    const amount = parseInt(ctx.message.text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('Пожалуйста, введите корректную сумму (числом).');
    }
    ctx.session.paymentAmount = amount;
    ctx.session.customPay = false;
    return ctx.reply(`Переведите ${amount} сум на карту: ${cardNumber}\nЗатем отправьте скриншот перевода.`);
  }

  // Обработка редактирования профиля
    if (ctx.session.editingField) {
    const field = ctx.session.editingField;
    const users = loadUsers();
    const index = users.findIndex(u => u.telegramId === ctx.from.id);
    if (index !== -1) {
        users[index][field] = ctx.message.text;
        saveUsers(users);
        ctx.reply(`✅ Информация обновлена.`);
    }
    ctx.session.editingField = null;
    return;
    }
  
  // Все прочие сообщения — игнор
  ctx.reply('Команда не распознана. Пожалуйста, используйте кнопки меню.', mainMenu());
});


bot.launch();
console.log('Бот запущен');
