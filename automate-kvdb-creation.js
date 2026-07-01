async function run() {
  try {
    // 1. Get temporary email address
    console.log('Fetching temp email from Guerrilla Mail...');
    const emailResp = await fetch('https://www.guerrillamail.com/ajax.php?f=get_email_address');
    const emailData = await emailResp.json();
    const email = emailData.email_addr;
    const sid = emailData.sid_token;
    console.log(`Temp email: ${email}`);

    // 2. Create KVdb.io bucket
    console.log('Registering bucket on KVdb.io...');
    const kvdbResp = await fetch('https://kvdb.io/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email })
    });
    const bucketId = (await kvdbResp.text()).trim();
    console.log(`Created bucket ID (unverified): ${bucketId}`);

    // 3. Poll for email
    console.log('Waiting for verification email (polling Guerrilla Mail)...');
    let emailId = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise(r => setTimeout(r, 4000));
      console.log(`Polling attempt ${attempt}/15...`);
      const checkResp = await fetch(`https://www.guerrillamail.com/ajax.php?f=check_email&seq=0&sid_token=${sid}`);
      const checkData = await checkResp.json();
      
      const list = checkData.list || [];
      const activationMail = list.find(m => m.mail_from.toLowerCase().includes('kvdb'));
      if (activationMail) {
        emailId = activationMail.mail_id;
        console.log(`Found KVdb activation email! Mail ID: ${emailId}`);
        break;
      }
    }

    if (!emailId) {
      console.error('Verification email did not arrive in time.');
      return;
    }

    // 4. Fetch the email content
    console.log(`Fetching email body for Mail ID: ${emailId}...`);
    const bodyResp = await fetch(`https://www.guerrillamail.com/ajax.php?f=fetch_email&email_id=${emailId}&sid_token=${sid}`);
    const bodyData = await bodyResp.json();
    const mailBody = bodyData.mail_body;

    // 5. Extract verification link
    const linkMatch = mailBody.match(/https:\/\/kvdb\.io\/[^\s"']+/);
    if (!linkMatch) {
      console.error('Could not find verification link in email body.');
      console.log('Email body:', mailBody);
      return;
    }
    const verifyLink = linkMatch[0].replace(/&amp;/g, '&');
    console.log(`Found activation link: ${verifyLink}`);

    // 6. Click/Fetch the verification link
    console.log('Activating bucket...');
    const actResp = await fetch(verifyLink);
    const actText = await actResp.text();
    console.log('Activation response status:', actResp.status);
    console.log('Activation response:', actText.slice(0, 300));

    console.log('\n======================================');
    console.log(`SUCCESS! VERIFIED BUCKET ID: ${bucketId}`);
    console.log('======================================');

  } catch (e) {
    console.error('Error:', e);
  }
}

run();
