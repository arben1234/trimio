async function test() {
  try {
    // Test 1: POST to api.npoint.io with empty object
    const r1 = await fetch('https://api.npoint.io', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: '{}'
    });
    console.log('Test 1 status:', r1.status);
    if (r1.ok) {
      console.log('Test 1 resp:', await r1.json());
    } else {
      console.log('Test 1 text:', (await r1.text()).slice(0, 200));
    }

    // Test 2: POST to api.npoint.io/bins
    const r2 = await fetch('https://api.npoint.io/bins', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: '{}'
    });
    console.log('Test 2 status:', r2.status);
    if (r2.ok) {
      console.log('Test 2 resp:', await r2.json());
    } else {
      console.log('Test 2 text:', (await r2.text()).slice(0, 200));
    }
  } catch (e) {
    console.error('Error:', e);
  }
}

test();
