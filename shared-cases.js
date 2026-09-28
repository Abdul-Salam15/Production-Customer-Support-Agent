/* RelayPay — call transcripts shared by the specialist queue (queue.js) and the customer's call history (customer.js).
   Prototype only: in production both views read the same case record from the API.
   Speakers: 'agent' | 'customer'; { type: 'form' } marks a typed callback form. 'at' = seconds into the call. */
(function () {
  var NOW = Date.now(), H = 3600 * 1000;
  var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Same as queue.js slot(): "Tue 15 Sep, 11:00" for a time h hours ago
  function slot(h, hh, mm) {
    var d = new Date(NOW - h * H); d.setHours(hh, mm, 0, 0);
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  var GREETING = 'Hello, this is RelayPay support. I\u2019m an AI agent and this call is recorded. How can I help?';
  var cb4790 = slot(312, 11, 0);

  window.RELAY_SHARED = {
    slot: slot,
    transcripts: {
      'RP-4802': [
        { speaker: 'agent', at: 2, text: GREETING },
        { speaker: 'customer', at: 9, text: 'We were charged a fee on TXN-8876 that doesn\u2019t match your published rates.' },
        { speaker: 'agent', at: 17, text: 'I can look into that. First I need to confirm the account. What is the registered business name?' },
        { speaker: 'customer', at: 23, text: 'LagosLedger.' },
        { speaker: 'agent', at: 31, text: 'Thank you, the account is verified. I\u2019m checking transaction records now.' },
        { speaker: 'agent', at: 48, text: 'TXN-8876 completed successfully. A 1.5% fee was applied to the conversion from naira to US dollars.' },
        { speaker: 'customer', at: 62, text: 'Our plan says 1%. That\u2019s why I\u2019m calling.' },
        { speaker: 'agent', at: 70, text: 'I can\u2019t change or refund fees on a call. Fee disputes are handled by our specialists. I\u2019ve created a ticket and someone will review the charge with you.' },
        { speaker: 'customer', at: 84, text: 'Fine. How will they contact me?' },
        { speaker: 'agent', at: 90, text: 'A specialist can call you back. When suits you?' },
        { speaker: 'customer', at: 98, text: 'Friday at two, Lagos time. Use the email on file.' },
        { speaker: 'agent', at: 107, text: 'Done. A specialist will call you on Friday at 14:00 WAT. Your reference is RP-4802.' },
        { speaker: 'customer', at: 115, text: 'Can you tell me what the published rate is for our plan?' },
        { speaker: 'agent', at: 123, text: 'On the Growth plan, currency conversion is charged at 1% above the mid-market rate, plus any fees from the receiving bank. The specialist can break down TXN-8876 for you.' },
        { speaker: 'customer', at: 138, text: 'Okay. That\u2019s all, thanks.' },
        { speaker: 'agent', at: 142, text: 'Thanks for calling RelayPay support. Your reference is RP-4802.' }
      ],
      'RP-4790': [
        { speaker: 'agent', at: 2, text: GREETING },
        { speaker: 'customer', at: 8, text: 'We added a new finance manager to our account, but their verification is stuck. Can you help?' },
        { speaker: 'agent', at: 16, text: 'I can check that. First I need to confirm the account. What is the registered business name?' },
        { speaker: 'customer', at: 21, text: 'LagosLedger.' },
        { speaker: 'agent', at: 29, text: 'Thank you, the account is verified. I\u2019m checking your account now.' },
        { speaker: 'agent', at: 41, text: 'I can see a team member verification that has been pending since last week. Team member verification is reviewed by our specialists, so I can\u2019t approve it on this call. I\u2019ve created a ticket so someone can check it with you.' },
        { speaker: 'customer', at: 58, text: 'Okay. Can someone call me about it?' },
        { speaker: 'agent', at: 63, text: 'Yes. You can add your details in the form on screen, or say them aloud.' },
        { speaker: 'customer', at: 69, text: 'I\u2019ll type them in.' },
        { type: 'form', at: 112, name: 'Amara Okafor', email: 'amara@lagosledger.example', callbackTime: cb4790, callbackTimezone: 'WAT \u00b7 Lagos', notes: 'New team member is Tobi Adeyemi, finance manager.' },
        { speaker: 'agent', at: 116, text: 'Thank you, I\u2019ve received your details. A specialist will call you on ' + cb4790.split(',')[0] + ' at 11:00 WAT. Your reference is RP-4790.' },
        { speaker: 'customer', at: 128, text: 'Great, thanks.' },
        { speaker: 'agent', at: 132, text: 'Thanks for calling RelayPay support.' }
      ]
    }
  };
})();
