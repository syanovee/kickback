#!/usr/bin/perl
# makes public/knots/index.html from public/index.html with KNOTS link previews (X, Telegram)
# usage: perl knots-page.pl public/index.html > public/knots/index.html
undef $/; my $s = <>;
my $t = 'KNOTS × Kickback · how much $STONK did your $KNOTS pay you?';
my $d = 'Paste your wallet and see every $STONK payout your $KNOTS sent you, each with its tx. No wallet connect.';
$s =~ s{<title>[^<]*</title>}{<title>$t</title>};
$s =~ s{(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*}{$1$t}g;
$s =~ s{(<meta (?:property="og:description"|name="twitter:description") content=")[^"]*}{$1$d}g;
$s =~ s{https://getkickback\.fun/og\.png}{https://getkickback.fun/kn/og.png}g;
$s =~ s{<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">}{<meta property="og:image:width" content="2400"><meta property="og:image:height" content="1260">};
$s =~ s{(<meta property="og:url" content=")[^"]*}{$1https://getkickback.fun/knots/};
$s =~ s{href="/favicon\.svg"}{href="/kn/favicon.svg"};
$s =~ s{href="/favicon-32\.png"}{href="/kn/favicon-32.png"};
$s =~ s{href="/apple-touch-icon\.png"}{href="/kn/apple-touch-icon.png"};
print $s;
