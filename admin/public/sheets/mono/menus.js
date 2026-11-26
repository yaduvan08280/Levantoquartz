// ============================================================
//  Mono Sheets — command bar & context menus
//  Google-Sheets-parity pass: button order/naming on the toolbar,
//  and the three distinct right-click variants (cell / row header /
//  column header), now follow docs/Google_Sheets_Menu_Toolbar_Reference.
//  Still ONE commandBar.js instance (U1's chrome-consolidation goal
//  stands) — Google's 9-menu top bar is used here only as an ordering
//  and naming reference, not rebuilt as a separate Drive-style menu
//  bar, since File/Extensions/Tools in Sheets are mostly Drive/add-on
//  integrations this local app has no equivalent for.
//
//  Toolbar left-to-right order mirrors "11. The Formatting Toolbar"
//  in the reference: Undo, Redo, Print, Paint format, Zoom, Currency,
//  Percent, Decimals, Font, Font size, Bold/Italic/Underline/Strike,
//  Text color, Fill color, Borders, Merge cells, Align, Wrap, Insert
//  link/comment/chart, Filter, Functions (Σ), More (⋯).
// ============================================================
import { commandBarHTML, wireCommandBar } from '../ui/commandBar.js';
import { icon } from '../ui/icons.js';

const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Values are plain font names (no CSS quoting). grid.js quotes multi-word names automatically.
// System fonts first, then Google Fonts alphabetically within groups.
const FONTS = [
  ['', 'Default'],
  // ── System fonts ────────────────────────────────────────────────────────────
  ['Arial', 'Arial'], ['Arial Black', 'Arial Black'], ['Calibri', 'Calibri'],
  ['Comic Sans MS', 'Comic Sans MS'], ['Courier New', 'Courier New'],
  ['Georgia', 'Georgia'], ['Helvetica Neue', 'Helvetica Neue'],
  ['Tahoma', 'Tahoma'], ['Times New Roman', 'Times New Roman'],
  ['Trebuchet MS', 'Trebuchet MS'], ['Verdana', 'Verdana'],
  // ── Google Fonts ─────────────────────────────────────────────────────────────
  ['ABeeZee', 'ABeeZee'], ['Abril Fatface', 'Abril Fatface'], ['Acme', 'Acme'],
  ['Actor', 'Actor'], ['Adamina', 'Adamina'], ['ADLaM Display', 'ADLaM Display'],
  ['Advent Pro', 'Advent Pro'], ['Afacad', 'Afacad'], ['Afacad Flux', 'Afacad Flux'],
  ['Agbalumo', 'Agbalumo'], ['Agdasima', 'Agdasima'], ['Aguafina Script', 'Aguafina Script'],
  ['Akatab', 'Akatab'], ['Akshar', 'Akshar'], ['Alata', 'Alata'],
  ['Alatsi', 'Alatsi'], ['Albert Sans', 'Albert Sans'], ['Aldrich', 'Aldrich'],
  ['Alef', 'Alef'], ['Alegreya', 'Alegreya'], ['Alegreya Sans', 'Alegreya Sans'],
  ['Alegreya Sans SC', 'Alegreya Sans SC'], ['Alegreya SC', 'Alegreya SC'],
  ['Alex Brush', 'Alex Brush'], ['Alexandria', 'Alexandria'], ['Alfa Slab One', 'Alfa Slab One'],
  ['Alice', 'Alice'], ['Alike', 'Alike'], ['Alike Angular', 'Alike Angular'],
  ['Allan', 'Allan'], ['Allerta', 'Allerta'], ['Allerta Stencil', 'Allerta Stencil'],
  ['Allison', 'Allison'], ['Allura', 'Allura'], ['Almarai', 'Almarai'],
  ['Almendra', 'Almendra'], ['Alumni Sans', 'Alumni Sans'], ['Amako', 'Amako'],
  ['Amatic SC', 'Amatic SC'], ['Amaranth', 'Amaranth'], ['Amarante', 'Amarante'],
  ['Amiko', 'Amiko'], ['Amiri', 'Amiri'], ['Andada Pro', 'Andada Pro'],
  ['Andika', 'Andika'], ['Angkor', 'Angkor'], ['Anuphan', 'Anuphan'],
  ['Anta', 'Anta'], ['Anton', 'Anton'], ['Anton SC', 'Anton SC'],
  ['Anybody', 'Anybody'], ['Anek Bangla', 'Anek Bangla'], ['Anek Devanagari', 'Anek Devanagari'],
  ['Anek Latin', 'Anek Latin'], ['Anek Telugu', 'Anek Telugu'],
  ['Anonymous Pro', 'Anonymous Pro'], ['Antic', 'Antic'], ['Antic Didone', 'Antic Didone'],
  ['Antic Slab', 'Antic Slab'], ['Antonio', 'Antonio'], ['Arapey', 'Arapey'],
  ['AR One Sans', 'AR One Sans'], ['Aref Ruqaa', 'Aref Ruqaa'], ['Arima', 'Arima'],
  ['Arimo', 'Arimo'], ['Armata', 'Armata'], ['Archivo', 'Archivo'],
  ['Archivo Black', 'Archivo Black'], ['Archivo Narrow', 'Archivo Narrow'],
  ['Arvo', 'Arvo'], ['Arya', 'Arya'], ['Asap', 'Asap'],
  ['Asap Condensed', 'Asap Condensed'], ['Asar', 'Asar'], ['Assistant', 'Assistant'],
  ['Athiti', 'Athiti'], ['Atkinson Hyperlegible', 'Atkinson Hyperlegible'],
  ['Atkinson Hyperlegible Next', 'Atkinson Hyperlegible Next'], ['Atma', 'Atma'],
  ['Audiowide', 'Audiowide'], ['Averia Libre', 'Averia Libre'],
  ['Averia Sans Libre', 'Averia Sans Libre'], ['Averia Serif Libre', 'Averia Serif Libre'],
  ['Azeret Mono', 'Azeret Mono'],
  ['B612', 'B612'], ['B612 Mono', 'B612 Mono'], ['Bad Script', 'Bad Script'],
  ['Bagel Fat One', 'Bagel Fat One'], ['Bai Jamjuree', 'Bai Jamjuree'],
  ['Bakbak One', 'Bakbak One'], ['Balsamiq Sans', 'Balsamiq Sans'],
  ['Balthazar', 'Balthazar'], ['Bangers', 'Bangers'], ['Barlow', 'Barlow'],
  ['Barlow Condensed', 'Barlow Condensed'], ['Barlow Semi Condensed', 'Barlow Semi Condensed'],
  ['Barriecito', 'Barriecito'], ['Basic', 'Basic'], ['Baskervville', 'Baskervville'],
  ['Baskervville SC', 'Baskervville SC'], ['Battambang', 'Battambang'],
  ['Baloo 2', 'Baloo 2'], ['Baloo Bhai 2', 'Baloo Bhai 2'],
  ['Baloo Bhaijaan 2', 'Baloo Bhaijaan 2'], ['Baloo Da 2', 'Baloo Da 2'],
  ['Baloo Paaji 2', 'Baloo Paaji 2'], ['Baloo Tamma 2', 'Baloo Tamma 2'],
  ['Baloo Thambi 2', 'Baloo Thambi 2'], ['Bayon', 'Bayon'],
  ['Be Vietnam Pro', 'Be Vietnam Pro'], ['Bebas Neue', 'Bebas Neue'],
  ['Belanosima', 'Belanosima'], ['Bellefair', 'Bellefair'], ['Belleza', 'Belleza'],
  ['Bellota Text', 'Bellota Text'], ['BenchNine', 'BenchNine'],
  ['Bentham', 'Bentham'], ['Berkshire Swash', 'Berkshire Swash'],
  ['Besley', 'Besley'], ['Bevan', 'Bevan'], ['BhuTuka Expanded One', 'BhuTuka Expanded One'],
  ['Big Shoulders', 'Big Shoulders'], ['Bigshot One', 'Bigshot One'],
  ['Bilbo Swash Caps', 'Bilbo Swash Caps'], ['BioRhyme', 'BioRhyme'],
  ['BIZ UDGothic', 'BIZ UDGothic'], ['BIZ UDPGothic', 'BIZ UDPGothic'],
  ['BIZ UDPMincho', 'BIZ UDPMincho'], ['Black Han Sans', 'Black Han Sans'],
  ['Black Ops One', 'Black Ops One'], ['Bitter', 'Bitter'],
  ['Blinker', 'Blinker'], ['Bodoni Moda', 'Bodoni Moda'],
  ['Bokor', 'Bokor'], ['Boldonse', 'Boldonse'], ['Bona Nova', 'Bona Nova'],
  ['Bona Nova SC', 'Bona Nova SC'], ['Boogaloo', 'Boogaloo'],
  ['Bowlby One', 'Bowlby One'], ['Bowlby One SC', 'Bowlby One SC'],
  ['Brawler', 'Brawler'], ['Bree Serif', 'Bree Serif'],
  ['Bricolage Grotesque', 'Bricolage Grotesque'], ['Brygada 1918', 'Brygada 1918'],
  ['Bubblegum Sans', 'Bubblegum Sans'], ['Buenard', 'Buenard'],
  ['Bungee', 'Bungee'], ['Bungee Inline', 'Bungee Inline'],
  ['Bungee Shade', 'Bungee Shade'],
  ['Cabin', 'Cabin'], ['Cabin Condensed', 'Cabin Condensed'],
  ['Cabin Sketch', 'Cabin Sketch'], ['Cairo', 'Cairo'],
  ['Caladea', 'Caladea'], ['Calistoga', 'Calistoga'],
  ['Cal Sans', 'Cal Sans'], ['Calligraffitti', 'Calligraffitti'],
  ['Cambo', 'Cambo'], ['Candal', 'Candal'], ['Cantarell', 'Cantarell'],
  ['Cantata One', 'Cantata One'], ['Caprasimo', 'Caprasimo'],
  ['Capriola', 'Capriola'], ['Carattere', 'Carattere'], ['Cardo', 'Cardo'],
  ['Carlito', 'Carlito'], ['Carrois Gothic', 'Carrois Gothic'],
  ['Carter One', 'Carter One'], ['Castoro', 'Castoro'], ['Catamaran', 'Catamaran'],
  ['Caudex', 'Caudex'], ['Caveat', 'Caveat'], ['Caveat Brush', 'Caveat Brush'],
  ['Cedarville Cursive', 'Cedarville Cursive'], ['Chakra Petch', 'Chakra Petch'],
  ['Changa', 'Changa'], ['Changa One', 'Changa One'], ['Chango', 'Chango'],
  ['Charis SIL', 'Charis SIL'], ['Charmonman', 'Charmonman'],
  ['Chelsea Market', 'Chelsea Market'], ['Chewy', 'Chewy'], ['Chivo', 'Chivo'],
  ['Chivo Mono', 'Chivo Mono'], ['Chonburi', 'Chonburi'], ['Cinzel', 'Cinzel'],
  ['Cinzel Decorative', 'Cinzel Decorative'], ['Coiny', 'Coiny'],
  ['Coda', 'Coda'], ['Codystar', 'Codystar'], ['Comfortaa', 'Comfortaa'],
  ['Comic Neue', 'Comic Neue'], ['Commissioner', 'Commissioner'],
  ['Concert One', 'Concert One'], ['Contrail One', 'Contrail One'],
  ['Cookie', 'Cookie'], ['Copse', 'Copse'], ['Corben', 'Corben'],
  ['Corinthia', 'Corinthia'], ['Cormorant', 'Cormorant'],
  ['Cormorant Garamond', 'Cormorant Garamond'], ['Cormorant Infant', 'Cormorant Infant'],
  ['Cormorant SC', 'Cormorant SC'], ['Cormorant Unicase', 'Cormorant Unicase'],
  ['Cormorant Upright', 'Cormorant Upright'], ['Courgette', 'Courgette'],
  ['Courier Prime', 'Courier Prime'], ['Cousine', 'Cousine'],
  ['Covered By Your Grace', 'Covered By Your Grace'],
  ['Crafty Girls', 'Crafty Girls'], ['Creepster', 'Creepster'],
  ['Crete Round', 'Crete Round'], ['Crimson Pro', 'Crimson Pro'],
  ['Crimson Text', 'Crimson Text'], ['Croissant One', 'Croissant One'],
  ['Cuprum', 'Cuprum'], ['Cutive', 'Cutive'], ['Cutive Mono', 'Cutive Mono'],
  ['DM Mono', 'DM Mono'], ['DM Sans', 'DM Sans'],
  ['DM Serif Display', 'DM Serif Display'], ['DM Serif Text', 'DM Serif Text'],
  ['Damion', 'Damion'], ['Dancing Script', 'Dancing Script'],
  ['Darker Grotesque', 'Darker Grotesque'], ['David Libre', 'David Libre'],
  ['Dawning of a New Day', 'Dawning of a New Day'], ['Days One', 'Days One'],
  ['Dela Gothic One', 'Dela Gothic One'], ['Delius', 'Delius'],
  ['Delius Unicase', 'Delius Unicase'], ['Della Respira', 'Della Respira'],
  ['Denk One', 'Denk One'], ['Didact Gothic', 'Didact Gothic'],
  ['Do Hyeon', 'Do Hyeon'], ['Domine', 'Domine'], ['Dongle', 'Dongle'],
  ['Doppio One', 'Doppio One'], ['Dosis', 'Dosis'], ['DotGothic16', 'DotGothic16'],
  ['Doto', 'Doto'], ['DynaPuff', 'DynaPuff'],
  ['EB Garamond', 'EB Garamond'], ['Eater', 'Eater'], ['Economica', 'Economica'],
  ['Eczar', 'Eczar'], ['El Messiri', 'El Messiri'], ['Electrolize', 'Electrolize'],
  ['Encode Sans', 'Encode Sans'], ['Encode Sans Condensed', 'Encode Sans Condensed'],
  ['Encode Sans Expanded', 'Encode Sans Expanded'],
  ['Encode Sans Semi Condensed', 'Encode Sans Semi Condensed'],
  ['Encode Sans Semi Expanded', 'Encode Sans Semi Expanded'],
  ['Enriqueta', 'Enriqueta'], ['Ephesis', 'Ephesis'], ['Epilogue', 'Epilogue'],
  ['Esteban', 'Esteban'], ['Euphoria Script', 'Euphoria Script'], ['Exo', 'Exo'],
  ['Exo 2', 'Exo 2'], ['Expletus Sans', 'Expletus Sans'],
  ['Fahkwang', 'Fahkwang'], ['Familjen Grotesk', 'Familjen Grotesk'],
  ['Fanwood Text', 'Fanwood Text'], ['Faster One', 'Faster One'],
  ['Faustina', 'Faustina'], ['Fauna One', 'Fauna One'], ['Federo', 'Federo'],
  ['Figtree', 'Figtree'], ['Finger Paint', 'Finger Paint'],
  ['Fira Code', 'Fira Code'], ['Fira Mono', 'Fira Mono'], ['Fira Sans', 'Fira Sans'],
  ['Fira Sans Condensed', 'Fira Sans Condensed'],
  ['Fira Sans Extra Condensed', 'Fira Sans Extra Condensed'],
  ['Fjalla One', 'Fjalla One'], ['Fjord One', 'Fjord One'],
  ['Flow Circular', 'Flow Circular'], ['Fondamento', 'Fondamento'],
  ['Fontdiner Swanky', 'Fontdiner Swanky'], ['Forum', 'Forum'],
  ['Fragment Mono', 'Fragment Mono'], ['Fraunces', 'Fraunces'],
  ['Frank Ruhl Libre', 'Frank Ruhl Libre'], ['Francois One', 'Francois One'],
  ['Fredericka the Great', 'Fredericka the Great'], ['Fredoka', 'Fredoka'],
  ['Freehand', 'Freehand'], ['Freeman', 'Freeman'], ['Fresca', 'Fresca'],
  ['Frijole', 'Frijole'], ['Fugaz One', 'Fugaz One'],
  ['Fustat', 'Fustat'], ['Fuzzy Bubbles', 'Fuzzy Bubbles'],
  ['GFS Didot', 'GFS Didot'], ['Gabarito', 'Gabarito'], ['Gabriela', 'Gabriela'],
  ['Gaegu', 'Gaegu'], ['Galada', 'Galada'], ['Gamja Flower', 'Gamja Flower'],
  ['Gantari', 'Gantari'], ['Gasoek One', 'Gasoek One'],
  ['Geist', 'Geist'], ['Geist Mono', 'Geist Mono'], ['Gelasio', 'Gelasio'],
  ['Geo', 'Geo'], ['Georama', 'Georama'], ['Geologica', 'Geologica'],
  ['GFS Didot', 'GFS Didot'], ['Gilda Display', 'Gilda Display'],
  ['Give You Glory', 'Give You Glory'], ['Glegoo', 'Glegoo'],
  ['Gloock', 'Gloock'], ['Gloria Hallelujah', 'Gloria Hallelujah'],
  ['Gluten', 'Gluten'], ['Goblin One', 'Goblin One'], ['Gochi Hand', 'Gochi Hand'],
  ['Goldman', 'Goldman'], ['Golos Text', 'Golos Text'], ['Gothic A1', 'Gothic A1'],
  ['Gotu', 'Gotu'], ['Gowun Batang', 'Gowun Batang'],
  ['Gowun Dodum', 'Gowun Dodum'], ['Graduate', 'Graduate'],
  ['Grand Hotel', 'Grand Hotel'], ['Grandstander', 'Grandstander'],
  ['Gravitas One', 'Gravitas One'], ['Great Vibes', 'Great Vibes'],
  ['Grenze Gotisch', 'Grenze Gotisch'], ['Gruppo', 'Gruppo'],
  ['Gudea', 'Gudea'], ['Gurajada', 'Gurajada'],
  ['Hachi Maru Pop', 'Hachi Maru Pop'], ['Hahmlet', 'Hahmlet'],
  ['Halant', 'Halant'], ['Hammersmith One', 'Hammersmith One'],
  ['Handlee', 'Handlee'], ['Hanken Grotesk', 'Hanken Grotesk'],
  ['Hanuman', 'Hanuman'], ['Happy Monkey', 'Happy Monkey'],
  ['Heebo', 'Heebo'], ['Hedvig Letters Serif', 'Hedvig Letters Serif'],
  ['Hepta Slab', 'Hepta Slab'], ['Herr Von Muellerhoff', 'Herr Von Muellerhoff'],
  ['Hina Mincho', 'Hina Mincho'], ['Hind', 'Hind'],
  ['Hind Guntur', 'Hind Guntur'], ['Hind Madurai', 'Hind Madurai'],
  ['Hind Siliguri', 'Hind Siliguri'], ['Hind Vadodara', 'Hind Vadodara'],
  ['Holtwood One SC', 'Holtwood One SC'], ['Homemade Apple', 'Homemade Apple'],
  ['Host Grotesk', 'Host Grotesk'],
  ['IBM Plex Mono', 'IBM Plex Mono'], ['IBM Plex Sans', 'IBM Plex Sans'],
  ['IBM Plex Sans Arabic', 'IBM Plex Sans Arabic'],
  ['IBM Plex Sans Condensed', 'IBM Plex Sans Condensed'],
  ['IBM Plex Sans Hebrew', 'IBM Plex Sans Hebrew'],
  ['IBM Plex Sans JP', 'IBM Plex Sans JP'], ['IBM Plex Sans KR', 'IBM Plex Sans KR'],
  ['IBM Plex Sans Thai', 'IBM Plex Sans Thai'], ['IBM Plex Serif', 'IBM Plex Serif'],
  ['IM Fell DW Pica', 'IM Fell DW Pica'], ['IM Fell Double Pica', 'IM Fell Double Pica'],
  ['IM Fell English', 'IM Fell English'], ['IM Fell English SC', 'IM Fell English SC'],
  ['Ibarra Real Nova', 'Ibarra Real Nova'], ['Iceberg', 'Iceberg'],
  ['Inclusive Sans', 'Inclusive Sans'], ['Inconsolata', 'Inconsolata'],
  ['Inder', 'Inder'], ['Indie Flower', 'Indie Flower'], ['Inria Sans', 'Inria Sans'],
  ['Inria Serif', 'Inria Serif'], ['Inknut Antiqua', 'Inknut Antiqua'],
  ['Instrument Sans', 'Instrument Sans'], ['Instrument Serif', 'Instrument Serif'],
  ['Inter', 'Inter'], ['Inter Tight', 'Inter Tight'], ['Irish Grover', 'Irish Grover'],
  ['Istok Web', 'Istok Web'], ['Italianno', 'Italianno'], ['Itim', 'Itim'],
  ['JetBrains Mono', 'JetBrains Mono'], ['Jaldi', 'Jaldi'],
  ['Jersey 25', 'Jersey 25'], ['Jockey One', 'Jockey One'],
  ['Josefin Sans', 'Josefin Sans'], ['Josefin Slab', 'Josefin Slab'],
  ['Jost', 'Jost'], ['Jua', 'Jua'], ['Judson', 'Judson'],
  ['Julee', 'Julee'], ['Julius Sans One', 'Julius Sans One'],
  ['Jura', 'Jura'], ['Just Another Hand', 'Just Another Hand'],
  ['K2D', 'K2D'], ['Kadwa', 'Kadwa'], ['Kaisei Decol', 'Kaisei Decol'],
  ['Kaisei Opti', 'Kaisei Opti'], ['Kaisei Tokumin', 'Kaisei Tokumin'],
  ['Kalam', 'Kalam'], ['Kalnia', 'Kalnia'], ['Kameron', 'Kameron'],
  ['Kanit', 'Kanit'], ['Karla', 'Karla'], ['Karma', 'Karma'],
  ['Kaushan Script', 'Kaushan Script'], ['KoHo', 'KoHo'], ['Kodchasan', 'Kodchasan'],
  ['Khand', 'Khand'], ['Klee One', 'Klee One'], ['Knewave', 'Knewave'],
  ['Kosugi', 'Kosugi'], ['Kosugi Maru', 'Kosugi Maru'],
  ['Koulen', 'Koulen'], ['Kranky', 'Kranky'], ['Kreon', 'Kreon'],
  ['Kristi', 'Kristi'], ['Krona One', 'Krona One'], ['Krub', 'Krub'],
  ['Kufam', 'Kufam'], ['Kurale', 'Kurale'], ['Kumbh Sans', 'Kumbh Sans'],
  ['La Belle Aurore', 'La Belle Aurore'], ['Lacquer', 'Lacquer'],
  ['Laila', 'Laila'], ['Lalezar', 'Lalezar'], ['Lateef', 'Lateef'],
  ['Lato', 'Lato'], ['League Gothic', 'League Gothic'],
  ['League Spartan', 'League Spartan'], ['League Script', 'League Script'],
  ['Leckerli One', 'Leckerli One'], ['Lekton', 'Lekton'],
  ['Lemonada', 'Lemonada'], ['Lexend', 'Lexend'],
  ['Lexend Deca', 'Lexend Deca'], ['Lexend Exa', 'Lexend Exa'],
  ['Lexend Giga', 'Lexend Giga'], ['Lexend Peta', 'Lexend Peta'],
  ['Lexend Zetta', 'Lexend Zetta'], ['Libre Barcode 39', 'Libre Barcode 39'],
  ['Libre Barcode 39 Extended Text', 'Libre Barcode 39 Extended Text'],
  ['Libre Barcode 39 Text', 'Libre Barcode 39 Text'],
  ['Libre Barcode 128', 'Libre Barcode 128'],
  ['Libre Baskerville', 'Libre Baskerville'], ['Libre Bodoni', 'Libre Bodoni'],
  ['Libre Caslon Display', 'Libre Caslon Display'],
  ['Libre Caslon Text', 'Libre Caslon Text'],
  ['Libre Franklin', 'Libre Franklin'], ['Lilita One', 'Lilita One'],
  ['Lily Script One', 'Lily Script One'], ['LINE Seed JP', 'LINE Seed JP'],
  ['Limelight', 'Limelight'], ['Literata', 'Literata'], ['Livvic', 'Livvic'],
  ['Lobster', 'Lobster'], ['Lobster Two', 'Lobster Two'],
  ['Londrina Solid', 'Londrina Solid'], ['Lora', 'Lora'],
  ['Love Ya Like A Sister', 'Love Ya Like A Sister'],
  ['Luckiest Guy', 'Luckiest Guy'], ['Lusitana', 'Lusitana'],
  ['Lustria', 'Lustria'],
  ['M PLUS 1', 'M PLUS 1'], ['M PLUS 1 Code', 'M PLUS 1 Code'],
  ['M PLUS 1p', 'M PLUS 1p'], ['M PLUS 2', 'M PLUS 2'],
  ['M PLUS Rounded 1c', 'M PLUS Rounded 1c'],
  ['Macondo', 'Macondo'], ['Mada', 'Mada'], ['Madimi One', 'Madimi One'],
  ['Magra', 'Magra'], ['Maitree', 'Maitree'], ['Major Mono Display', 'Major Mono Display'],
  ['Mako', 'Mako'], ['Mali', 'Mali'], ['Mallanna', 'Mallanna'],
  ['Mandali', 'Mandali'], ['Manrope', 'Manrope'], ['Mansalva', 'Mansalva'],
  ['Marcellus', 'Marcellus'], ['Marcellus SC', 'Marcellus SC'],
  ['Marck Script', 'Marck Script'], ['Markazi Text', 'Markazi Text'],
  ['Marmelad', 'Marmelad'], ['Martel', 'Martel'], ['Martel Sans', 'Martel Sans'],
  ['Marvel', 'Marvel'], ['Mate', 'Mate'], ['Maven Pro', 'Maven Pro'],
  ['McLaren', 'McLaren'], ['MedievalSharp', 'MedievalSharp'],
  ['Meddon', 'Meddon'], ['Megrim', 'Megrim'], ['Meie Script', 'Meie Script'],
  ['Meow Script', 'Meow Script'], ['Merienda', 'Merienda'],
  ['Merriweather', 'Merriweather'], ['Merriweather Sans', 'Merriweather Sans'],
  ['Metamorphous', 'Metamorphous'], ['Metrophobic', 'Metrophobic'],
  ['Michroma', 'Michroma'], ['Miriam Libre', 'Miriam Libre'],
  ['Mitr', 'Mitr'], ['Modak', 'Modak'], ['Mochiy Pop One', 'Mochiy Pop One'],
  ['Mohave', 'Mohave'], ['Molengo', 'Molengo'], ['Mona Sans', 'Mona Sans'],
  ['Monda', 'Monda'], ['Monsieur La Doulaise', 'Monsieur La Doulaise'],
  ['Monoton', 'Monoton'], ['Montagu Slab', 'Montagu Slab'],
  ['Montez', 'Montez'], ['Montserrat', 'Montserrat'],
  ['Montserrat Alternates', 'Montserrat Alternates'], ['Moon Dance', 'Moon Dance'],
  ['Mouse Memoirs', 'Mouse Memoirs'], ['Mr Dafoe', 'Mr Dafoe'],
  ['Mr De Haviland', 'Mr De Haviland'], ['Mrs Saint Delafield', 'Mrs Saint Delafield'],
  ['Ms Madi', 'Ms Madi'], ['Mukta', 'Mukta'], ['Mukta Mahee', 'Mukta Mahee'],
  ['Mukta Malar', 'Mukta Malar'], ['Mukta Vaani', 'Mukta Vaani'],
  ['Mulish', 'Mulish'], ['Murecho', 'Murecho'], ['MuseoModerno', 'MuseoModerno'],
  ['Nanum Brush Script', 'Nanum Brush Script'], ['Nanum Gothic', 'Nanum Gothic'],
  ['Nanum Gothic Coding', 'Nanum Gothic Coding'],
  ['Nanum Myeongjo', 'Nanum Myeongjo'], ['Nanum Pen Script', 'Nanum Pen Script'],
  ['Nata Sans', 'Nata Sans'], ['Nerko One', 'Nerko One'],
  ['Neucha', 'Neucha'], ['Neuton', 'Neuton'], ['News Cycle', 'News Cycle'],
  ['Newsreader', 'Newsreader'], ['Niconne', 'Niconne'], ['Niramit', 'Niramit'],
  ['Nixie One', 'Nixie One'], ['Nobile', 'Nobile'],
  ['Norican', 'Norican'], ['Nosifer', 'Nosifer'], ['Nothing You Could Do', 'Nothing You Could Do'],
  ['Noticia Text', 'Noticia Text'],
  ['Noto Emoji', 'Noto Emoji'], ['Noto Naskh Arabic', 'Noto Naskh Arabic'],
  ['Noto Nastaliq Urdu', 'Noto Nastaliq Urdu'], ['Noto Sans', 'Noto Sans'],
  ['Noto Sans Arabic', 'Noto Sans Arabic'], ['Noto Sans Bengali', 'Noto Sans Bengali'],
  ['Noto Sans Devanagari', 'Noto Sans Devanagari'],
  ['Noto Sans Georgian', 'Noto Sans Georgian'],
  ['Noto Sans Gujarati', 'Noto Sans Gujarati'],
  ['Noto Sans Gurmukhi', 'Noto Sans Gurmukhi'],
  ['Noto Sans HK', 'Noto Sans HK'], ['Noto Sans Hebrew', 'Noto Sans Hebrew'],
  ['Noto Sans JP', 'Noto Sans JP'], ['Noto Sans Kannada', 'Noto Sans Kannada'],
  ['Noto Sans Khmer', 'Noto Sans Khmer'], ['Noto Sans KR', 'Noto Sans KR'],
  ['Noto Sans Malayalam', 'Noto Sans Malayalam'],
  ['Noto Sans Meetei Mayek', 'Noto Sans Meetei Mayek'],
  ['Noto Sans Mono', 'Noto Sans Mono'], ['Noto Sans Myanmar', 'Noto Sans Myanmar'],
  ['Noto Sans Ol Chiki', 'Noto Sans Ol Chiki'], ['Noto Sans Oriya', 'Noto Sans Oriya'],
  ['Noto Sans SC', 'Noto Sans SC'], ['Noto Sans Sinhala', 'Noto Sans Sinhala'],
  ['Noto Sans Symbols', 'Noto Sans Symbols'], ['Noto Sans Tamil', 'Noto Sans Tamil'],
  ['Noto Sans TC', 'Noto Sans TC'], ['Noto Sans Telugu', 'Noto Sans Telugu'],
  ['Noto Sans Thai', 'Noto Sans Thai'],
  ['Noto Serif Bengali', 'Noto Serif Bengali'],
  ['Noto Serif Devanagari', 'Noto Serif Devanagari'],
  ['Noto Serif Georgian', 'Noto Serif Georgian'],
  ['Noto Serif Hebrew', 'Noto Serif Hebrew'],
  ['Noto Serif Khojki', 'Noto Serif Khojki'], ['Noto Serif Thai', 'Noto Serif Thai'],
  ['Nova Mono', 'Nova Mono'], ['Nova Square', 'Nova Square'],
  ['NTR', 'NTR'], ['Nunito', 'Nunito'], ['Nunito Sans', 'Nunito Sans'],
  ['Old Standard TT', 'Old Standard TT'], ['Oleo Script', 'Oleo Script'],
  ['Oleo Script Swash Caps', 'Oleo Script Swash Caps'],
  ['Onest', 'Onest'], ['Open Sans', 'Open Sans'], ['Oregano', 'Oregano'],
  ['Orbitron', 'Orbitron'], ['Oranienbaum', 'Oranienbaum'],
  ['Original Surfer', 'Original Surfer'], ['Orienta', 'Orienta'],
  ['Oswald', 'Oswald'], ['Outfit', 'Outfit'], ['Over the Rainbow', 'Over the Rainbow'],
  ['Overlock', 'Overlock'], ['Overpass', 'Overpass'],
  ['Overpass Mono', 'Overpass Mono'], ['Ovo', 'Ovo'],
  ['Oxanium', 'Oxanium'], ['Oxygen', 'Oxygen'], ['Oxygen Mono', 'Oxygen Mono'],
  ['PT Mono', 'PT Mono'], ['PT Sans', 'PT Sans'],
  ['PT Sans Caption', 'PT Sans Caption'], ['PT Sans Narrow', 'PT Sans Narrow'],
  ['PT Serif', 'PT Serif'], ['PT Serif Caption', 'PT Serif Caption'],
  ['Pacifico', 'Pacifico'], ['Padauk', 'Padauk'], ['Palanquin', 'Palanquin'],
  ['Palanquin Dark', 'Palanquin Dark'], ['Pangolin', 'Pangolin'],
  ['Parkinsans', 'Parkinsans'], ['Parisienne', 'Parisienne'],
  ['Passion One', 'Passion One'], ['Patrick Hand', 'Patrick Hand'],
  ['Patua One', 'Patua One'], ['Pattaya', 'Pattaya'], ['Paytone One', 'Paytone One'],
  ['Permanent Marker', 'Permanent Marker'], ['Petit Formal Script', 'Petit Formal Script'],
  ['Petrona', 'Petrona'], ['Philosopher', 'Philosopher'],
  ['Piazzolla', 'Piazzolla'], ['Pirata One', 'Pirata One'],
  ['Pinyon Script', 'Pinyon Script'], ['Pixelify Sans', 'Pixelify Sans'],
  ['Play', 'Play'], ['Playball', 'Playball'], ['Playfair', 'Playfair'],
  ['Playfair Display', 'Playfair Display'],
  ['Playfair Display SC', 'Playfair Display SC'], ['Playpen Sans', 'Playpen Sans'],
  ['Plus Jakarta Sans', 'Plus Jakarta Sans'], ['Podkova', 'Podkova'],
  ['Poetsen One', 'Poetsen One'], ['Poiret One', 'Poiret One'],
  ['Poller One', 'Poller One'], ['Poly', 'Poly'], ['Pompiere', 'Pompiere'],
  ['Pontano Sans', 'Pontano Sans'], ['Poor Story', 'Poor Story'],
  ['Poppins', 'Poppins'], ['Port Lligat Sans', 'Port Lligat Sans'],
  ['Potta One', 'Potta One'], ['Pragati Narrow', 'Pragati Narrow'],
  ['Prata', 'Prata'], ['Press Start 2P', 'Press Start 2P'],
  ['Pridi', 'Pridi'], ['Prompt', 'Prompt'], ['Protest Revolution', 'Protest Revolution'],
  ['Proxima Nova', 'Proxima Nova'], ['Proza Libre', 'Proza Libre'],
  ['Public Sans', 'Public Sans'], ['Puritan', 'Puritan'],
  ['Quantico', 'Quantico'], ['Quattrocento', 'Quattrocento'],
  ['Quattrocento Sans', 'Quattrocento Sans'], ['Questrial', 'Questrial'],
  ['Quicksand', 'Quicksand'], ['Qahiri', 'Qahiri'],
  ['Qwitcher Grypen', 'Qwitcher Grypen'], ['Qwigley', 'Qwigley'],
  ['REM', 'REM'], ['Racing Sans One', 'Racing Sans One'],
  ['Radio Canada', 'Radio Canada'], ['Radio Canada Big', 'Radio Canada Big'],
  ['Rajdhani', 'Rajdhani'], ['Rakkas', 'Rakkas'], ['Raleway', 'Raleway'],
  ['Ramabhadra', 'Ramabhadra'], ['Rambla', 'Rambla'], ['Rammetto One', 'Rammetto One'],
  ['Rampart One', 'Rampart One'], ['Rancho', 'Rancho'], ['Rasa', 'Rasa'],
  ['Readex Pro', 'Readex Pro'], ['Red Hat Display', 'Red Hat Display'],
  ['Red Hat Mono', 'Red Hat Mono'], ['Red Hat Text', 'Red Hat Text'],
  ['Red Rose', 'Red Rose'], ['Reddit Sans', 'Reddit Sans'],
  ['Reddit Sans Condensed', 'Reddit Sans Condensed'], ['Redressed', 'Redressed'],
  ['Reenie Beanie', 'Reenie Beanie'], ['Reggae One', 'Reggae One'],
  ['Reem Kufi', 'Reem Kufi'], ['Rethink Sans', 'Rethink Sans'],
  ['Righteous', 'Righteous'], ['Roboto', 'Roboto'],
  ['Roboto Condensed', 'Roboto Condensed'], ['Roboto Mono', 'Roboto Mono'],
  ['Roboto Serif', 'Roboto Serif'], ['Roboto Slab', 'Roboto Slab'],
  ['Rochester', 'Rochester'], ['Rock Salt', 'Rock Salt'],
  ['RocknRoll One', 'RocknRoll One'], ['Rokkitt', 'Rokkitt'],
  ['Ropa Sans', 'Ropa Sans'], ['Rosario', 'Rosario'], ['Rowdies', 'Rowdies'],
  ['Rozha One', 'Rozha One'], ['Rubik', 'Rubik'], ['Rubik Dirt', 'Rubik Dirt'],
  ['Rubik Doodle Shadow', 'Rubik Doodle Shadow'], ['Rubik Glitch', 'Rubik Glitch'],
  ['Rubik Mono One', 'Rubik Mono One'], ['Ruda', 'Ruda'],
  ['Rufina', 'Rufina'], ['Russo One', 'Russo One'], ['Rye', 'Rye'],
  ['STIX Two Math', 'STIX Two Math'], ['STIX Two Text', 'STIX Two Text'],
  ['SUSE', 'SUSE'], ['Sacramento', 'Sacramento'], ['Sail', 'Sail'],
  ['Saira', 'Saira'], ['Saira Condensed', 'Saira Condensed'],
  ['Saira Extra Condensed', 'Saira Extra Condensed'],
  ['Saira Semi Condensed', 'Saira Semi Condensed'], ['Sanchez', 'Sanchez'],
  ['Sansation', 'Sansation'], ['Sansita', 'Sansita'],
  ['Sansita Swashed', 'Sansita Swashed'], ['Sarabun', 'Sarabun'],
  ['Sarala', 'Sarala'], ['Sarina', 'Sarina'], ['Satisfy', 'Satisfy'],
  ['Sawarabi Gothic', 'Sawarabi Gothic'], ['Sawarabi Mincho', 'Sawarabi Mincho'],
  ['Scada', 'Scada'], ['Schibsted Grotesk', 'Schibsted Grotesk'],
  ['Scheherazade New', 'Scheherazade New'], ['Schoolbell', 'Schoolbell'],
  ['Secular One', 'Secular One'], ['Sedgwick Ave', 'Sedgwick Ave'],
  ['Sedgwick Ave Display', 'Sedgwick Ave Display'], ['Sen', 'Sen'],
  ['Shadows Into Light', 'Shadows Into Light'],
  ['Shadows Into Light Two', 'Shadows Into Light Two'],
  ['Shantell Sans', 'Shantell Sans'], ['Share', 'Share'],
  ['Share Tech', 'Share Tech'], ['Share Tech Mono', 'Share Tech Mono'],
  ['Shippori Antique', 'Shippori Antique'], ['Shrikhand', 'Shrikhand'],
  ['Sigmar One', 'Sigmar One'], ['Signika', 'Signika'],
  ['Signika Negative', 'Signika Negative'], ['Silkscreen', 'Silkscreen'],
  ['Sintony', 'Sintony'], ['Siemreap', 'Siemreap'], ['Six Caps', 'Six Caps'],
  ['Skranji', 'Skranji'], ['Slabo 13px', 'Slabo 13px'],
  ['Slabo 27px', 'Slabo 27px'], ['Slackey', 'Slackey'], ['Smooch Sans', 'Smooch Sans'],
  ['Sniglet', 'Sniglet'], ['Sofia', 'Sofia'], ['Sofia Sans', 'Sofia Sans'],
  ['Sofia Sans Condensed', 'Sofia Sans Condensed'],
  ['Sofia Sans Extra Condensed', 'Sofia Sans Extra Condensed'],
  ['Sofia Sans Semi Condensed', 'Sofia Sans Semi Condensed'],
  ['Solitreo', 'Solitreo'], ['Sometype Mono', 'Sometype Mono'],
  ['Sora', 'Sora'], ['Source Code Pro', 'Source Code Pro'],
  ['Source Sans 3', 'Source Sans 3'], ['Source Serif 4', 'Source Serif 4'],
  ['Space Grotesk', 'Space Grotesk'], ['Space Mono', 'Space Mono'],
  ['Special Elite', 'Special Elite'], ['Special Gothic', 'Special Gothic'],
  ['Special Gothic Condensed One', 'Special Gothic Condensed One'],
  ['Special Gothic Expanded One', 'Special Gothic Expanded One'],
  ['Spectral', 'Spectral'], ['Spectral SC', 'Spectral SC'],
  ['Spinnaker', 'Spinnaker'], ['Spline Sans', 'Spline Sans'],
  ['Spline Sans Mono', 'Spline Sans Mono'], ['Squada One', 'Squada One'],
  ['Square Peg', 'Square Peg'], ['Sriracha', 'Sriracha'],
  ['Staatliches', 'Staatliches'], ['Stardos Stencil', 'Stardos Stencil'],
  ['Stick No Bills', 'Stick No Bills'], ['Style Script', 'Style Script'],
  ['Suez One', 'Suez One'], ['Sumana', 'Sumana'], ['Suranna', 'Suranna'],
  ['Sue Ellen Francisco', 'Sue Ellen Francisco'], ['Syncopate', 'Syncopate'],
  ['Syne', 'Syne'], ['Syne Mono', 'Syne Mono'],
  ['Tajawal', 'Tajawal'], ['Tangerine', 'Tangerine'], ['Taviraj', 'Taviraj'],
  ['Teachers', 'Teachers'], ['Tektur', 'Tektur'], ['Telex', 'Telex'],
  ['Tenali Ramakrishna', 'Tenali Ramakrishna'], ['Tenor Sans', 'Tenor Sans'],
  ['Thasadith', 'Thasadith'], ['The Girl Next Door', 'The Girl Next Door'],
  ['Tienne', 'Tienne'], ['TikTok Sans', 'TikTok Sans'],
  ['Tilt Neon', 'Tilt Neon'], ['Tilt Warp', 'Tilt Warp'],
  ['Titan One', 'Titan One'], ['Titillium Web', 'Titillium Web'],
  ['Tomorrow', 'Tomorrow'], ['Train One', 'Train One'],
  ['Tinos', 'Tinos'], ['Tiro Bangla', 'Tiro Bangla'],
  ['Tiro Devanagari Hindi', 'Tiro Devanagari Hindi'], ['Trirong', 'Trirong'],
  ['Trocchi', 'Trocchi'], ['Truculenta', 'Truculenta'], ['Turret Road', 'Turret Road'],
  ['Ubuntu', 'Ubuntu'], ['Ubuntu Condensed', 'Ubuntu Condensed'],
  ['Ubuntu Mono', 'Ubuntu Mono'], ['Ubuntu Sans', 'Ubuntu Sans'],
  ['Ultra', 'Ultra'], ['Unbounded', 'Unbounded'],
  ['UnifrakturMaguntia', 'UnifrakturMaguntia'], ['Unica One', 'Unica One'],
  ['Unkempt', 'Unkempt'], ['Unna', 'Unna'], ['Urbanist', 'Urbanist'],
  ['VT323', 'VT323'], ['Varela', 'Varela'], ['Varela Round', 'Varela Round'],
  ['Varta', 'Varta'], ['Vast Shadow', 'Vast Shadow'], ['Vazirmatn', 'Vazirmatn'],
  ['Vesper Libre', 'Vesper Libre'], ['Viaoda Libre', 'Viaoda Libre'],
  ['Vibur', 'Vibur'], ['Vidaloka', 'Vidaloka'], ['Viga', 'Viga'],
  ['Vina Sans', 'Vina Sans'], ['Voces', 'Voces'], ['Volkhov', 'Volkhov'],
  ['Vollkorn', 'Vollkorn'], ['Vollkorn SC', 'Vollkorn SC'], ['Voltaire', 'Voltaire'],
  ['Waiting for the Sunrise', 'Waiting for the Sunrise'],
  ['Wallpoet', 'Wallpoet'], ['Walter Turncoat', 'Walter Turncoat'],
  ['Waterfall', 'Waterfall'], ['Wendy One', 'Wendy One'],
  ['Wire One', 'Wire One'], ['Wix Madefor Display', 'Wix Madefor Display'],
  ['Wix Madefor Text', 'Wix Madefor Text'], ['Work Sans', 'Work Sans'],
  ['Xanh Mono', 'Xanh Mono'],
  ['Yanone Kaffeesatz', 'Yanone Kaffeesatz'], ['Yatra One', 'Yatra One'],
  ['Yellowtail', 'Yellowtail'], ['Yesteryear', 'Yesteryear'],
  ['Yeseva One', 'Yeseva One'], ['Young Serif', 'Young Serif'],
  ['Yrsa', 'Yrsa'], ['Yuji Mai', 'Yuji Mai'], ['Yuji Syuku', 'Yuji Syuku'],
  ['Yusei Magic', 'Yusei Magic'],
  ['ZCOOL KuaiLe', 'ZCOOL KuaiLe'], ['ZCOOL QingKe HuangYou', 'ZCOOL QingKe HuangYou'],
  ['ZCOOL XiaoWei', 'ZCOOL XiaoWei'], ['Zain', 'Zain'],
  ['Zalando Sans', 'Zalando Sans'], ['Zalando Sans Expanded', 'Zalando Sans Expanded'],
  ['Zalando Sans SemiExpanded', 'Zalando Sans SemiExpanded'],
  ['Zen Antique', 'Zen Antique'], ['Zen Antique Soft', 'Zen Antique Soft'],
  ['Zen Dots', 'Zen Dots'], ['Zen Kaku Gothic Antique', 'Zen Kaku Gothic Antique'],
  ['Zen Kaku Gothic New', 'Zen Kaku Gothic New'], ['Zen Kurenaido', 'Zen Kurenaido'],
  ['Zen Maru Gothic', 'Zen Maru Gothic'], ['Zen Old Mincho', 'Zen Old Mincho'],
  ['Zeyada', 'Zeyada'], ['Zilla Slab', 'Zilla Slab'],
];

// Lazy-load a Google Font by name (no-op if already loaded or a system font).
const _loadedFonts = new Set(['Arial','Arial Black','Calibri','Comic Sans MS','Courier New',
  'Georgia','Helvetica Neue','Tahoma','Times New Roman','Trebuchet MS','Verdana']);
function loadGoogleFont(name) {
  if (!name || _loadedFonts.has(name)) return;
  _loadedFonts.add(name);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name) + ':wght@400;700&display=swap';
  document.head.appendChild(link);
}
export { loadGoogleFont };

// ── Font-family picker (custom dropdown so each name renders in its own font) ──
const FAV_KEY = 'mono_font_favs';
const getFavs = () => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); } };
const saveFavs = (s) => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch {} };

function fontFamilyHTML(st) {
  const ff = st.ff || '';
  const label = ff || 'Default';
  return `<button type="button" class="cmdbar-select ms-font-btn" id="cbFontFamilyBtn" title="Font" data-ff="${escAttr(ff)}" style="${ff ? `font-family:'${escAttr(ff)}',sans-serif` : ''}">${escAttr(label)}</button>`;
}
function fontSizeHTML(st) {
  const cur = st.fs || 12;
  return `<input type="number" class="cmdbar-select cmdbar-select-sm" id="cbFontSize" title="Font size" min="1" max="400" value="${cur}" style="padding:0 4px;text-align:center">`;
}

function openFontPicker(grid, btn) {
  // Close any open picker first
  document.getElementById('msFontPanel')?.remove();
  const favs = getFavs();
  const curFont = grid.sheet().getStyle(grid.active.r, grid.active.c)?.ff || '';
  const r = btn.getBoundingClientRect();

  const favList = FONTS.filter(([v]) => v && favs.has(v));

  const itemHTML = ([v, l]) => {
    const isCur = v === curFont;
    return `<div class="ms-font-item${isCur ? ' ms-font-cur' : ''}" data-font="${escAttr(v)}" data-label="${escAttr(l)}" role="option" aria-selected="${isCur}">` +
      `<span class="ms-font-preview">${escAttr(l)}</span>` +
      (v ? `<button type="button" class="ms-font-fav${favs.has(v) ? ' liked' : ''}" data-fav="${escAttr(v)}" title="Favourite">♥</button>` : '') +
      `</div>`;
  };

  const panel = document.createElement('div');
  panel.id = 'msFontPanel';
  panel.className = 'ms-font-panel';
  panel.style.cssText = `left:${Math.round(r.left)}px;top:${Math.round(r.bottom + 2)}px`;
  panel.innerHTML =
    `<input class="ms-font-search" id="msFontSearch" placeholder="Search fonts…" autocomplete="off" spellcheck="false">` +
    `<div class="ms-font-list" id="msFontList" role="listbox">` +
      (favList.length ? `<div class="ms-font-section">Favourites</div>${favList.map(itemHTML).join('')}<div class="ms-font-section">All Fonts</div>` : '') +
      FONTS.map(itemHTML).join('') +
    `</div>`;
  document.body.appendChild(panel);

  // Scroll to current font
  const curEl = panel.querySelector('.ms-font-cur');
  if (curEl) requestAnimationFrame(() => curEl.scrollIntoView({ block: 'center' }));

  // Focus search
  const searchEl = panel.querySelector('#msFontSearch');
  searchEl.focus();

  // Lazy-load font as each item scrolls into view
  const listEl = panel.querySelector('#msFontList');
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const name = entry.target.dataset.font;
      if (!name) return;
      loadGoogleFont(name);
      const preview = entry.target.querySelector('.ms-font-preview');
      if (preview) preview.style.fontFamily = `'${name}',sans-serif`;
      obs.unobserve(entry.target);
    });
  }, { root: listEl, rootMargin: '60px 0px', threshold: 0 });
  panel.querySelectorAll('.ms-font-item[data-font]').forEach(el => { if (el.dataset.font) obs.observe(el); });

  // Search filter
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim().toLowerCase();
    panel.querySelectorAll('.ms-font-item').forEach(el => {
      el.style.display = !q || (el.dataset.label || '').toLowerCase().includes(q) ? '' : 'none';
    });
    panel.querySelectorAll('.ms-font-section').forEach(el => { el.style.display = q ? 'none' : ''; });
  });

  // Apply / favourite clicks
  panel.addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.stopPropagation();
      const name = fav.dataset.fav;
      const cur = getFavs();
      if (cur.has(name)) cur.delete(name); else cur.add(name);
      saveFavs(cur);
      panel.querySelectorAll(`[data-fav="${CSS.escape(name)}"]`).forEach(el => el.classList.toggle('liked', cur.has(name)));
      return;
    }
    const item = e.target.closest('.ms-font-item');
    if (item) {
      const v = item.dataset.font || '';
      if (v) loadGoogleFont(v);
      close();
      grid.setFontFamily(v);          // applyStyle re-renders the toolbar, so the button label updates itself
    }
  });

  // Keyboard: Esc closes, Enter applies first visible match
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); grid.focusGrid?.(); }
    else if (e.key === 'Enter') {
      const first = [...panel.querySelectorAll('.ms-font-item')].find(el => el.style.display !== 'none' && el.dataset.font !== undefined);
      if (first) { const v = first.dataset.font || ''; if (v) loadGoogleFont(v); close(); grid.setFontFamily(v); }
    }
  });

  // Keep the panel on-screen
  requestAnimationFrame(() => {
    const pr = panel.getBoundingClientRect();
    if (pr.bottom > innerHeight - 8) panel.style.top = Math.max(8, innerHeight - pr.height - 8) + 'px';
    if (pr.right > innerWidth - 8) panel.style.left = Math.max(8, innerWidth - pr.width - 8) + 'px';
  });

  function close() { obs.disconnect(); panel.remove(); document.removeEventListener('mousedown', onOutside); }
  const onOutside = (e) => { if (!panel.contains(e.target) && e.target !== btn) close(); };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
}

function buildLeft(st = {}) {
  return [
    { cmd: 'undo', icon: 'undo', title: 'Undo (Ctrl+Z)' },
    { cmd: 'redo', icon: 'redo', title: 'Redo (Ctrl+Y)' },
    'sep',
    { cmd: 'print', icon: 'printer', title: 'Print (Ctrl+P)' },
    { cmd: 'paintFormat', icon: 'paint-roller', title: 'Paint format — copy formatting from one cell to another' },
    'sep',
    { split: true, id: 'zoom', icon: 'zoom-in', title: 'Zoom', items: [
      { cmd: 'zoom50', label: '50%' }, { cmd: 'zoom75', label: '75%' }, { cmd: 'zoom90', label: '90%' },
      { cmd: 'zoom100', label: '100%' }, { cmd: 'zoom125', label: '125%' }, { cmd: 'zoom150', label: '150%' }, { cmd: 'zoom200', label: '200%' },
      'sep', { cmd: 'zoomFit', label: 'Fit to window' },
    ] },
    'sep',
    { cmd: 'nfCurrency', icon: 'currency', title: 'Format as currency (Ctrl+Shift+4)' },
    { cmd: 'nfPercent', icon: 'percent', title: 'Format as percent (Ctrl+Shift+5)' },
    { cmd: 'decDec', icon: 'minus', title: 'Decrease decimal places' },
    { cmd: 'decInc', icon: 'plus', title: 'Increase decimal places' },
    { split: true, id: 'numfmt', icon: 'hash', title: 'More number formats (Ctrl+1)', items: [
      { cmd: 'nfAuto',       label: 'Automatic',  kbd: 'Ctrl+Shift+~' },
      { cmd: 'nfNumber',     label: 'Number',     kbd: 'Ctrl+Shift+1' },
      { cmd: 'nfTime',       label: 'Time',       kbd: 'Ctrl+Shift+2' },
      { cmd: 'nfDate',       label: 'Date',       kbd: 'Ctrl+Shift+3' },
      { cmd: 'nfCurrency',   label: 'Currency',   kbd: 'Ctrl+Shift+4' },
      { cmd: 'nfPercent',    label: 'Percent',    kbd: 'Ctrl+Shift+5' },
      { cmd: 'nfScientific', label: 'Scientific', kbd: 'Ctrl+Shift+6' },
      'sep',
      { cmd: 'openNumberFormatDlg', label: 'Format cells…', kbd: 'Ctrl+1' },
    ] },
    'sep',
    { html: fontFamilyHTML(st) },
    { html: fontSizeHTML(st) },
    'sep',
    { cmd: 'bold', icon: 'bold', title: 'Bold (Ctrl+B)' },
    { cmd: 'italic', icon: 'italic', title: 'Italic (Ctrl+I)' },
    { cmd: 'underline', icon: 'underline', title: 'Underline (Ctrl+U)' },
    { cmd: 'strike', icon: 'strikethrough', title: 'Strikethrough (Alt+Shift+5)' },
    'sep',
    { cmd: 'textColor', icon: 'text-color', title: 'Text color' },
    { cmd: 'fillColor', icon: 'fill-color', title: 'Fill color' },
    // Borders opens the Border studio popover directly (no dropdown menu).
    { cmd: 'borders', icon: 'borders', title: 'Borders' },
    { split: true, id: 'merge', icon: 'merge', title: 'Merge cells', items: [
      { cmd: 'merge', icon: 'merge', label: 'Merge all' },
      { cmd: 'mergeHoriz', icon: 'merge', label: 'Merge horizontally' },
      { cmd: 'mergeVert', icon: 'merge', label: 'Merge vertically' },
      'sep',
      { cmd: 'unmerge', icon: 'x', label: 'Unmerge' },
    ] },
    'sep',
    { split: true, id: 'halign', icon: 'align-left', title: 'Horizontal align', items: [
      { cmd: 'alignL', icon: 'align-left', label: 'Left' },
      { cmd: 'alignC', icon: 'align-center', label: 'Center' },
      { cmd: 'alignR', icon: 'align-right', label: 'Right' },
    ] },
    { split: true, id: 'valign', icon: 'align-middle', title: 'Vertical align', items: [
      { cmd: 'vAlignTop', icon: 'align-top', label: 'Top' },
      { cmd: 'vAlignMiddle', icon: 'align-middle', label: 'Middle' },
      { cmd: 'vAlignBottom', icon: 'align-bottom', label: 'Bottom' },
    ] },
    { split: true, id: 'wrap', icon: 'wrap', title: 'Text wrapping', items: [
      { cmd: 'wrapOverflow', label: 'Overflow' },
      { cmd: 'wrapWrap', icon: 'wrap', label: 'Wrap' },
      { cmd: 'wrapClip', label: 'Clip' },
    ] },
    'sep',
    { cmd: 'insertLink', icon: 'link', title: 'Insert link (Ctrl+K)' },
    { cmd: 'insertComment', icon: 'message-square', title: 'Insert comment (Ctrl+Alt+C)' },
    { cmd: 'insertChart', icon: 'bar-chart', title: 'Insert chart — opens the selection in Dashboard (F11)' },
    'sep',
    { cmd: 'find', icon: 'search', title: 'Find and replace (Ctrl+F / Ctrl+H)' },
    { split: true, id: 'filter', icon: 'filter', title: 'Filter (Ctrl+Shift+L)', items: [
      { cmd: 'toggleFilter', icon: 'filter', label: 'Toggle filter', kbd: 'Ctrl+Shift+L' },
      { cmd: 'createFilter', icon: 'filter', label: 'Create filter', kbd: 'Ctrl+Shift+T' },
      { cmd: 'removeFilter', icon: 'x', label: 'Remove filter' },
    ] },
    { split: true, id: 'functions', icon: 'sigma', title: 'Functions', items: [
      { cmd: 'autosum', icon: 'sigma', label: 'SUM (autosum)', kbd: 'Alt+=' },
      'sep',
      { cmd: 'fnSum',     label: 'SUM' },
      { cmd: 'fnAverage', label: 'AVERAGE' },
      { cmd: 'fnCount',   label: 'COUNT' },
      { cmd: 'fnMax',     label: 'MAX' },
      { cmd: 'fnMin',     label: 'MIN' },
      'sep',
      { cmd: 'openFunctionBrowser', label: 'More functions…' },
    ] },
  ];
}

const RIGHT = [
  // P9: live Views button — opens the add-view picker
  { html: '<button type="button" class="cmdbar-btn" data-cmd="viewsPanel" title="Views">' + icon('layers', { size: 16 }) + '<span class="cmdbar-label">Views</span></button>' },
  // P13: Copilot panel toggle (also Ctrl/Cmd+/ and the command palette)
  { html: '<button type="button" class="cmdbar-btn" data-cmd="copilot" title="Copilot (Ctrl+/)">' + icon('sparkles', { size: 16 }) + '<span class="cmdbar-label">Copilot</span></button>' },
];

const OVERFLOW = [
  { section: 'Edit', items: [
    { cmd: 'cut', icon: 'cut', label: 'Cut', kbd: 'Ctrl+X' },
    { cmd: 'copy', icon: 'copy', label: 'Copy', kbd: 'Ctrl+C' },
    { cmd: 'paste', icon: 'paste', label: 'Paste', kbd: 'Ctrl+V' },
    { cmd: 'pasteSpecial', icon: 'paste', label: 'Paste special…', kbd: 'Ctrl+Shift+V' },
    { label: 'Paste special', icon: 'paste', items: [
      { cmd: 'pasteValuesOnly', label: 'Values only' },
      { cmd: 'pasteFormatOnly', label: 'Format only' },
      { cmd: 'pasteFormulasOnly', label: 'Formulas only' },
      { cmd: 'pasteTransposed', label: 'Transposed' },
    ] },
    { cmd: 'find', icon: 'search', label: 'Find and replace', kbd: 'Ctrl+F' },
    { cmd: 'saveNow', icon: 'check', label: 'Save workbook', kbd: 'Ctrl+S' },
  ] },
  { section: 'Insert', items: [
    { cmd: 'insertCellsDialog', icon: 'plus', label: 'Insert cells…', kbd: 'Ctrl+Shift++' },
    { cmd: 'insRowAbove', icon: 'row-insert', label: 'Insert row above' },
    { cmd: 'insRowBelow', icon: 'row-insert', label: 'Insert row below' },
    { cmd: 'insColLeft', icon: 'col-insert', label: 'Insert column left' },
    { cmd: 'insColRight', icon: 'col-insert', label: 'Insert column right' },
    { cmd: 'insertDate', icon: 'calendar', label: "Today's date", kbd: 'Ctrl+;' },
    { cmd: 'insertTime', icon: 'history', label: 'Current time', kbd: 'Ctrl+Shift+;' },
    { cmd: 'insertCheckbox', icon: 'check', label: 'Checkbox' },
    { cmd: 'insertDropdown', icon: 'chevron-down', label: 'Dropdown' },
    { cmd: 'insertNote', icon: 'sticky-note', label: 'Insert note', kbd: 'Shift+F2' },
  ] },
  { section: 'Delete / clear', items: [
    { cmd: 'deleteCellsDialog', icon: 'trash', label: 'Delete cells…', kbd: 'Ctrl+-' },
    { label: 'Delete', icon: 'trash', items: [
      { cmd: 'deleteValues', label: 'Values' },
      { cmd: 'delRow', label: 'Row' },
      { cmd: 'delCol', label: 'Column' },
      { cmd: 'deleteCellsShiftUp', label: 'Cells and shift up' },
      { cmd: 'deleteCellsShiftLeft', label: 'Cells and shift left' },
      { cmd: 'clearNotes', label: 'Notes' },
    ] },
    { cmd: 'clear', icon: 'trash', label: 'Clear contents', kbd: 'Del' },
    { cmd: 'clearFormat', icon: 'x', label: 'Clear formatting', kbd: 'Ctrl+Shift+X' },
  ] },
  { section: 'Data', items: [
    { cmd: 'sortAsc', icon: 'sort-asc', label: 'Sort range A → Z' },
    { cmd: 'sortDesc', icon: 'sort-desc', label: 'Sort range Z → A' },
    { cmd: 'named', icon: 'link', label: 'Named ranges' },
    { cmd: 'validation', icon: 'check', label: 'Data validation' },
    { cmd: 'protectRange', icon: 'lock', label: 'Protect range' },
    { cmd: 'unprotectRange', icon: 'unlock', label: 'Unprotect range' },
    { cmd: 'trimWhitespace', label: 'Trim whitespace' },
    { cmd: 'removeDuplicates', label: 'Remove duplicates', kbd: 'Ctrl+Alt+D' },
    { cmd: 'randomizeRange', icon: 'shuffle', label: 'Randomize range' },
    { cmd: 'splitTextToCols', icon: 'columns', label: 'Split text to columns' },
    { cmd: 'useInDashboard', icon: 'layout-dashboard', label: 'Use in dashboard' },
    { cmd: 'recalc', icon: 'refresh-cw', label: 'Recalculate now', kbd: 'F9' },
    { cmd: 'csv', icon: 'download', label: 'Export CSV' },
  ] },
  { section: 'Conditional formatting', items: [
    { cmd: 'cond', icon: 'filter', label: 'Highlight rule…' },
    { cmd: 'condScale', icon: 'bar-chart', label: 'Color scale…' },
    { cmd: 'condBar', icon: 'bar-chart', label: 'Data bars…' },
  ] },
  { section: 'View — freeze rows', items: [
    { cmd: 'freezeNoRows', label: 'No rows' }, { cmd: 'freeze1Row', label: '1 row' }, { cmd: 'freeze2Rows', label: '2 rows' }, { cmd: 'freezeUpToRow', icon: 'table', label: 'Up to current row' },
  ] },
  { section: 'View — freeze columns', items: [
    { cmd: 'freezeNoCols', label: 'No columns' }, { cmd: 'freeze1Col', label: '1 column' }, { cmd: 'freeze2Cols', label: '2 columns' }, { cmd: 'freezeUpToCol', icon: 'table', label: 'Up to current column' },
  ] },
  { section: 'View', items: [
    { cmd: 'unfreeze', icon: 'table', label: 'Unfreeze' },
    { cmd: 'toggleGridlines', icon: 'grid', label: 'Toggle gridlines' },
    { cmd: 'toggleShowFormulas', label: 'Show formulas', kbd: 'Ctrl+`' },
    { cmd: 'toggleChrome', label: 'Hide/show toolbar', kbd: 'Ctrl+F1' },
    { cmd: 'toggleFullScreen', icon: 'maximize', label: 'Full screen' },
    { cmd: 'hideRow', icon: 'eye-off', label: 'Hide rows', kbd: 'Ctrl+9' },
    { cmd: 'hideCol', icon: 'eye-off', label: 'Hide columns', kbd: 'Ctrl+0' },
    { cmd: 'showAllRows', icon: 'eye', label: 'Show all hidden rows', kbd: 'Ctrl+Shift+9' },
    { cmd: 'showAllCols', icon: 'eye', label: 'Show all hidden columns', kbd: 'Ctrl+Shift+0' },
  ] },
  { section: 'Sheet', items: [
    { cmd: 'addSheet', icon: 'file-plus', label: 'New sheet', kbd: 'Shift+F11' },
    { cmd: 'jumpToCell', icon: 'search', label: 'Go to a cell reference', kbd: 'Ctrl+G / F5' },
    { cmd: 'goToLastCell', icon: 'corner-down-right', label: 'Go to last used cell', kbd: 'Ctrl+End' },
  ] },
  { section: 'Help', items: [
    { cmd: 'shortcutsHelp', icon: 'keyboard', label: 'Keyboard shortcuts', kbd: 'Ctrl+?' },
  ] },
];

/**
 * Toolbar row only — packed left-to-right like Google Sheets' formatting
 * toolbar, with the overflow "More" button as the next item after the last
 * button (not stretched to the far edge by a flex spacer). The formula bar
 * (name box + fx + input) is a *separate* row, built by grid.js, directly
 * underneath — merging the two into one flex row was what caused the big
 * empty gap and the toolbar not matching the reference layout.
 * @param {object} activeStyle - the active cell's style object, used to
 *   pre-select the font-family/font-size controls on render.
 */
export function barsHTML(activeStyle = {}) {
  return commandBarHTML({ left: buildLeft(activeStyle), right: RIGHT, overflow: OVERFLOW, spacer: false });
}

export function wireBars(grid, root) {
  wireCommandBar(root, (cmd) => grid.command(cmd));
  const ffBtn = root.querySelector('#cbFontFamilyBtn'); if (ffBtn) ffBtn.addEventListener('click', () => openFontPicker(grid, ffBtn));
  const fs = root.querySelector('#cbFontSize'); if (fs) fs.addEventListener('change', () => grid.setFontSize(fs.value));
}

// Flat { cmd, icon, label } list for every leaf command above — feeds the
// U6 command palette's registry so every sheet action is searchable.
export function allCommandMeta() {
  const out = []; const seen = new Set();
  const walk = (arr) => { for (const it of arr) { if (it === 'sep' || it.html != null) continue; if (it.items) { walk(it.items); continue; } if (it.cmd && !seen.has(it.cmd)) { seen.add(it.cmd); out.push({ cmd: it.cmd, icon: it.icon, label: it.label || it.title || it.cmd, kbd: it.kbd }); } } };
  walk(buildLeft({})); walk(RIGHT);
  for (const sec of OVERFLOW) walk(sec.items || []);
  return out;
}

/* ============================================================
 *  Right-click context menus — Google Sheets parity.
 *  Three distinct variants (cell / row header / col header).
 *  Paste special is a proper flyout sub-menu. Insert cells and
 *  Delete cells also have flyouts. Sort items are on col header
 *  only (matching Google's layout — not on the cell context menu).
 * ============================================================ */
let _ctxOutsideHandler = null;
let _subCloseTimer = null;
function clearSubClose() { if (_subCloseTimer) { clearTimeout(_subCloseTimer); _subCloseTimer = null; } }
function closeContext() {
  clearSubClose();
  document.getElementById('msCtxSub')?.remove();
  document.getElementById('msCtx')?.remove();
  if (_ctxOutsideHandler) {
    document.removeEventListener('mousedown', _ctxOutsideHandler);
    _ctxOutsideHandler = null;
  }
}

// Item format: [cmd, icon, label, kbdOrSubItems?]
//   kbdOrSubItems string  → keyboard shortcut hint on the right
//   kbdOrSubItems array   → hover flyout sub-menu
function cellItems() {
  return [
    ['cut',   'cut',   'Cut',   'Ctrl+X'],
    ['copy',  'copy',  'Copy',  'Ctrl+C'],
    ['paste', 'paste', 'Paste', 'Ctrl+V'],
    [null, 'paste', 'Paste special', [
      ['pasteSpecial',          null, 'Paste special…',    'Ctrl+Shift+V'],
      'sep',
      ['pasteValuesOnly',       null, 'Values only'],
      ['pasteFormatOnly',       null, 'Formatting only'],
      ['pasteFormulasOnly',     null, 'Formulas only'],
      ['pasteTransposed',       null, 'Transposed'],
      'sep',
      ['pasteValuesAndFormat',  null, 'Values & formatting'],
      ['pasteAllExceptBorders', null, 'All except borders'],
    ]],
    'sep',
    ['insRowAbove', 'row-insert', 'Insert 1 row above'],
    ['insRowBelow', 'row-insert', 'Insert 1 row below'],
    ['insColLeft',  'col-insert', 'Insert 1 column to the left'],
    ['insColRight', 'col-insert', 'Insert 1 column to the right'],
    [null, null, 'Insert cells', [
      ['insertCellsDialog',     null, 'Insert cells…', 'Ctrl+Shift++'],
      'sep',
      ['insertCellsShiftDown',  null, 'Shift cells down'],
      ['insertCellsShiftRight', null, 'Shift cells right'],
    ]],
    'sep',
    ['delRow',       'trash', 'Delete row'],
    ['delCol',       'trash', 'Delete column'],
    [null, null, 'Delete cells', [
      ['deleteCellsDialog',    null, 'Delete cells…', 'Ctrl+-'],
      'sep',
      ['deleteCellsShiftUp',   null, 'Shift cells up'],
      ['deleteCellsShiftLeft', null, 'Shift cells left'],
    ]],
    ['deleteValues', null, 'Clear contents'],
    'sep',
    ['createFilter',   'filter',        'Create a filter'],
    ['insertLink',     'link',          'Insert link', 'Ctrl+K'],
    ['insertComment',  'message-square','Comment',   'Ctrl+Alt+C'],
    ['insertNote',     'sticky-note',   'Note',      'Shift+F2'],
    ['insertDropdown', 'chevron-down',  'Drop-down'],
    'sep',
    ['getCellRef', 'link', 'Get link to this cell'],
    'sep',
    ['cond',         'filter', 'Conditional formatting'],
    ['validation',   'check',  'Data validation'],
    ['protectRange', 'lock',   'Protect range'],
    ['named',        'link',   'Define named range'],
  ];
}
function rowHeaderItems() {
  return [
    ['cut',   'cut',   'Cut',   'Ctrl+X'],
    ['copy',  'copy',  'Copy',  'Ctrl+C'],
    ['paste', 'paste', 'Paste', 'Ctrl+V'],
    'sep',
    ['insRowAbove', 'row-insert', 'Insert rows above'],
    ['insRowBelow', 'row-insert', 'Insert rows below'],
    'sep',
    ['clearNotes',   null,       'Clear notes'],
    ['deleteValues', null,       'Clear contents'],
    ['delRow',      'trash',     'Delete row'],
    ['hideRow',     'eye-off',   'Hide row'],
    'sep',
    ['resizeRowPrompt', 'table', 'Resize row'],
    ['resizeRowFit',    'table', 'Resize row to fit'],
    'sep',
    ['protectRange',   'lock',   'Protect row'],
    ['unprotectRange', 'unlock', 'Unprotect row'],
  ];
}
function colHeaderItems() {
  return [
    ['cut',   'cut',   'Cut',   'Ctrl+X'],
    ['copy',  'copy',  'Copy',  'Ctrl+C'],
    ['paste', 'paste', 'Paste', 'Ctrl+V'],
    'sep',
    ['insColLeft',  'col-insert', 'Insert columns to the left'],
    ['insColRight', 'col-insert', 'Insert columns to the right'],
    'sep',
    ['clearNotes',   null,         'Clear notes'],
    ['deleteValues', null,         'Clear contents'],
    ['delCol',      'trash',       'Delete column'],
    ['hideCol',     'eye-off',     'Hide column'],
    'sep',
    ['resizeColPrompt', 'columns', 'Resize column'],
    ['resizeColFit',    'columns', 'Resize to fit data'],
    ['resizeAllCols',   'columns', 'Resize all columns'],
    'sep',
    ['sortColAsc',  'sort-asc',  'Sort A → Z'],
    ['sortColDesc', 'sort-desc', 'Sort Z → A'],
    'sep',
    ['protectRange',   'lock',   'Protect column'],
    ['unprotectRange', 'unlock', 'Unprotect column'],
    'sep',
    ['setColType', 'tag', 'Set column type…'],
  ];
}

function renderCtxItems(items) {
  return items.map((it, i) => {
    if (it === 'sep') return '<div class="ms-ctx-sep"></div>';
    const hasSub = Array.isArray(it[3]);
    const kbdHint = (!hasSub && typeof it[3] === 'string') ? `<span class="ms-ctx-kbd">${it[3]}</span>` : '';
    const arrow   = hasSub ? '<span class="ms-ctx-arrow">›</span>' : '';
    return `<button class="ms-ctx-item" data-idx="${i}">${it[1] ? icon(it[1], { size: 14 }) : '<span class="ms-ctx-noicon"></span>'}<span class="ms-ctx-label">${it[2]}</span>${kbdHint}${arrow}</button>`;
  }).join('');
}

function wireCtxItems(el, items, grid, onClose, isSubMenu = false) {
  // If this IS the sub-menu, cancel any pending close when the mouse enters it
  // (handles diagonal mouse movement from parent button to flyout panel)
  if (isSubMenu) el.addEventListener('mouseenter', clearSubClose);

  el.querySelectorAll('.ms-ctx-item').forEach((btn) => {
    const i = +btn.dataset.idx; const it = items[i]; if (!it || it === 'sep') return;
    if (Array.isArray(it[3])) {
      btn.addEventListener('mouseenter', () => {
        // Clear any delayed close, then open the new flyout immediately
        clearSubClose();
        document.getElementById('msCtxSub')?.remove();
        const sub = document.createElement('div'); sub.className = 'ms-ctx'; sub.id = 'msCtxSub';
        sub.innerHTML = renderCtxItems(it[3]);
        document.body.appendChild(sub);
        const r = btn.getBoundingClientRect();
        sub.style.left = Math.min(r.right + 2, innerWidth  - sub.offsetWidth  - 6) + 'px';
        sub.style.top  = Math.min(r.top  - 5,  innerHeight - sub.offsetHeight - 6) + 'px';
        wireCtxItems(sub, it[3], grid, onClose, true);
      });
    } else {
      btn.addEventListener('click', () => { if (it[0]) grid.command(it[0]); onClose(); });
      if (!isSubMenu) {
        // Main-menu non-flyout items: delay close so diagonal movement to flyout doesn't kill it
        btn.addEventListener('mouseenter', () => {
          clearSubClose();
          _subCloseTimer = setTimeout(() => { _subCloseTimer = null; document.getElementById('msCtxSub')?.remove(); }, 150);
        });
      }
      // Sub-menu items: do NOT add a close handler — hovering within the flyout must not remove it
    }
  });
}

/* Read-only roles (Commenter/Viewer) see only non-mutating entries; the
   comment item stays for Commenters. grid.command() re-checks either way. */
const RO_CTX = new Set(['copy', 'insertComment', 'print', 'exportCSV', 'csv']);
function filterReadOnly(items, canComment) {
  const keep = (cmd) => cmd && RO_CTX.has(cmd) && (cmd !== 'insertComment' || canComment);
  return items
    .map((it) => {
      if (it === 'sep') return it;
      const [cmd, icn, label, kbdOrSub] = it;
      if (Array.isArray(kbdOrSub)) return null;          // flyouts are all mutating (paste/insert/delete)
      return keep(cmd) ? it : null;
    })
    .filter((it, i, arr) => it && !(it === 'sep' && (i === 0 || arr[i - 1] === 'sep' || arr[i - 1] == null)));
}

export function showContextMenu(grid, x, y, kind = 'cell') {
  closeContext();
  let items = kind === 'row' ? rowHeaderItems() : kind === 'col' ? colHeaderItems() : cellItems();
  if (grid.access && !grid.access.canEdit) {
    items = filterReadOnly(items, !!grid.access.canComment);
    if (!items.length) return;
  }
  const el = document.createElement('div'); el.className = 'ms-ctx'; el.id = 'msCtx';
  el.innerHTML = renderCtxItems(items);
  document.body.appendChild(el);
  el.style.left = Math.min(x, innerWidth  - el.offsetWidth  - 6) + 'px';
  el.style.top  = Math.min(y, innerHeight - el.offsetHeight - 6) + 'px';
  wireCtxItems(el, items, grid, closeContext);
  // Close only when clicking OUTSIDE the menus — not on mousedown inside them,
  // which would remove the DOM before the click event fires on the button.
  _ctxOutsideHandler = (e) => {
    if (!e.target.closest('#msCtx') && !e.target.closest('#msCtxSub')) closeContext();
  };
  setTimeout(() => document.addEventListener('mousedown', _ctxOutsideHandler), 0);
}

/* ============================================================
 *  Top-of-grid text menu bar — File | Edit | View | Insert |
 *  Format | Data | Tools | Extensions | Help
 * ============================================================ */
const MENU_BAR_DEF = [
  { label: 'File', id: 'file', items: [
    { cmd: 'saveNow',            label: 'Save',                     kbd: 'Ctrl+S' },
    { cmd: 'print',              label: 'Print',                    kbd: 'Ctrl+P' },
    'sep',
    { cmd: 'importFile',         label: 'Import CSV / Excel…',      kbd: 'Ctrl+O' },
    { cmd: 'csv',                label: 'Download as CSV' },
    { cmd: 'downloadXlsx',       label: 'Download as Excel (.xlsx)' },
    'sep',
    { cmd: 'openSettings',       label: 'Workbook settings' },
  ]},
  { label: 'Edit', id: 'edit', items: [
    { cmd: 'undo',               label: 'Undo',                     kbd: 'Ctrl+Z' },
    { cmd: 'redo',               label: 'Redo',                     kbd: 'Ctrl+Y' },
    'sep',
    { cmd: 'cut',                label: 'Cut',                      kbd: 'Ctrl+X' },
    { cmd: 'copy',               label: 'Copy',                     kbd: 'Ctrl+C' },
    { cmd: 'paste',              label: 'Paste',                    kbd: 'Ctrl+V' },
    { label: 'Paste special', sub: [
      { cmd: 'pasteSpecial',             label: 'Paste special…',       kbd: 'Ctrl+Shift+V' },
      'sep',
      { cmd: 'pasteValuesOnly',          label: 'Values only' },
      { cmd: 'pasteFormatOnly',          label: 'Formatting only' },
      { cmd: 'pasteFormulasOnly',        label: 'Formulas only' },
      { cmd: 'pasteTransposed',          label: 'Transposed' },
      'sep',
      { cmd: 'pasteValuesAndFormat',     label: 'Values & formatting' },
      { cmd: 'pasteAllExceptBorders',    label: 'All except borders' },
    ]},
    'sep',
    { cmd: 'find',               label: 'Find and replace',         kbd: 'Ctrl+F' },
    'sep',
    { cmd: 'fillDown',           label: 'Fill down',                kbd: 'Ctrl+D' },
    { cmd: 'fillRight',          label: 'Fill right',               kbd: 'Ctrl+R' },
    { cmd: 'insertDate',         label: "Insert today's date",      kbd: 'Ctrl+;' },
    { cmd: 'insertTime',         label: 'Insert current time',      kbd: 'Ctrl+Shift+;' },
    'sep',
    { cmd: 'clear',              label: 'Clear contents',           kbd: 'Del' },
    { cmd: 'clearFormat',        label: 'Clear formatting',         kbd: 'Ctrl+Shift+X' },
    'sep',
    { label: 'Delete', sub: [
      { cmd: 'deleteCellsDialog',    label: 'Delete cells…',        kbd: 'Ctrl+-' },
      { cmd: 'delRow',               label: 'Delete row' },
      { cmd: 'delCol',               label: 'Delete column' },
      { cmd: 'deleteCellsShiftUp',   label: 'Delete cells and shift up' },
      { cmd: 'deleteCellsShiftLeft', label: 'Delete cells and shift left' },
    ]},
  ]},
  { label: 'View', id: 'view', items: [
    { label: 'Freeze rows', sub: [
      { cmd: 'freezeNoRows',  label: 'No rows' },
      { cmd: 'freeze1Row',    label: '1 row' },
      { cmd: 'freeze2Rows',   label: '2 rows' },
      { cmd: 'freezeUpToRow', label: 'Up to current row' },
    ]},
    { label: 'Freeze columns', sub: [
      { cmd: 'freezeNoCols',  label: 'No columns' },
      { cmd: 'freeze1Col',    label: '1 column' },
      { cmd: 'freeze2Cols',   label: '2 columns' },
      { cmd: 'freezeUpToCol', label: 'Up to current column' },
    ]},
    { cmd: 'unfreeze',           label: 'Unfreeze all' },
    'sep',
    { cmd: 'toggleGridlines',    label: 'Gridlines' },
    { cmd: 'toggleShowFormulas', label: 'Show formulas',            kbd: 'Ctrl+`' },
    { cmd: 'toggleChrome',       label: 'Hide/show toolbar',        kbd: 'Ctrl+F1' },
    'sep',
    { cmd: 'toggleFullScreen',   label: 'Full screen' },
    'sep',
    { cmd: 'hideRow',            label: 'Hide rows',                kbd: 'Ctrl+9' },
    { cmd: 'hideCol',            label: 'Hide columns',             kbd: 'Ctrl+0' },
    { cmd: 'showAllRows',        label: 'Show all hidden rows',     kbd: 'Ctrl+Shift+9' },
    { cmd: 'showAllCols',        label: 'Show all hidden columns',  kbd: 'Ctrl+Shift+0' },
    'sep',
    { label: 'Zoom', sub: [
      { cmd: 'zoom50',  label: '50%'  }, { cmd: 'zoom75',  label: '75%' },
      { cmd: 'zoom90',  label: '90%'  }, { cmd: 'zoom100', label: '100%' },
      { cmd: 'zoom125', label: '125%' }, { cmd: 'zoom150', label: '150%' },
      { cmd: 'zoom200', label: '200%' },
    ]},
  ]},
  { label: 'Insert', id: 'insert', items: [
    { cmd: 'insRowAbove',        label: 'Row above' },
    { cmd: 'insRowBelow',        label: 'Row below' },
    { cmd: 'insColLeft',         label: 'Column to the left' },
    { cmd: 'insColRight',        label: 'Column to the right' },
    { label: 'Insert cells', sub: [
      { cmd: 'insertCellsDialog',     label: 'Insert cells…',       kbd: 'Ctrl+Shift++' },
      { cmd: 'insertCellsShiftDown',  label: 'Shift cells down' },
      { cmd: 'insertCellsShiftRight', label: 'Shift cells right' },
    ]},
    'sep',
    { cmd: 'addSheet',           label: 'New sheet',                kbd: 'Shift+F11' },
    'sep',
    { cmd: 'autosum',            label: 'AutoSum',                  kbd: 'Alt+=' },
    { cmd: 'openFunctionBrowser', label: 'Function…' },
    { cmd: 'insertDate',         label: "Today's date",             kbd: 'Ctrl+;' },
    { cmd: 'insertTime',         label: 'Current time',             kbd: 'Ctrl+Shift+;' },
    'sep',
    { cmd: 'insertLink',         label: 'Link',                     kbd: 'Ctrl+K' },
    { cmd: 'insertComment',      label: 'Comment',                  kbd: 'Ctrl+Alt+C' },
    { cmd: 'insertNote',         label: 'Note',                     kbd: 'Shift+F2' },
    'sep',
    { cmd: 'insertCheckbox',     label: 'Checkbox' },
    { cmd: 'insertDropdown',     label: 'Dropdown' },
    'sep',
    { cmd: 'insertChart',        label: 'Chart / Dashboard' },
  ]},
  { label: 'Format', id: 'format', items: [
    { cmd: 'bold',               label: 'Bold',                     kbd: 'Ctrl+B' },
    { cmd: 'italic',             label: 'Italic',                   kbd: 'Ctrl+I' },
    { cmd: 'underline',          label: 'Underline',                kbd: 'Ctrl+U' },
    { cmd: 'strike',             label: 'Strikethrough',            kbd: 'Alt+Shift+5' },
    'sep',
    { label: 'Number', sub: [
      { cmd: 'nfAuto',                label: 'Automatic',  kbd: 'Ctrl+Shift+~' },
      { cmd: 'nfNumber',              label: 'Number',     kbd: 'Ctrl+Shift+1' },
      { cmd: 'nfTime',                label: 'Time',       kbd: 'Ctrl+Shift+2' },
      { cmd: 'nfDate',                label: 'Date',       kbd: 'Ctrl+Shift+3' },
      { cmd: 'nfCurrency',            label: 'Currency',   kbd: 'Ctrl+Shift+4' },
      { cmd: 'nfPercent',             label: 'Percent',    kbd: 'Ctrl+Shift+5' },
      { cmd: 'nfScientific',          label: 'Scientific', kbd: 'Ctrl+Shift+6' },
      'sep',
      { cmd: 'openNumberFormatDlg',   label: 'Format cells…', kbd: 'Ctrl+1' },
    ]},
    'sep',
    { label: 'Alignment', sub: [
      { cmd: 'alignL',        label: 'Left' },
      { cmd: 'alignC',        label: 'Center' },
      { cmd: 'alignR',        label: 'Right' },
      'sep',
      { cmd: 'vAlignTop',     label: 'Top' },
      { cmd: 'vAlignMiddle',  label: 'Middle' },
      { cmd: 'vAlignBottom',  label: 'Bottom' },
    ]},
    { label: 'Text wrapping', sub: [
      { cmd: 'wrapOverflow',  label: 'Overflow' },
      { cmd: 'wrapWrap',      label: 'Wrap' },
      { cmd: 'wrapClip',      label: 'Clip' },
    ]},
    'sep',
    { label: 'Merge cells', sub: [
      { cmd: 'merge',         label: 'Merge all' },
      { cmd: 'mergeHoriz',    label: 'Merge horizontally' },
      { cmd: 'mergeVert',     label: 'Merge vertically' },
      { cmd: 'unmerge',       label: 'Unmerge' },
    ]},
    'sep',
    { cmd: 'cond',               label: 'Conditional formatting' },
    { cmd: 'condScale',          label: 'Color scale' },
    { cmd: 'condBar',            label: 'Data bars' },
    'sep',
    { cmd: 'borderOuter',        label: 'Outline border',           kbd: 'Ctrl+Shift+&' },
    { cmd: 'borderNone',         label: 'Remove borders',           kbd: 'Ctrl+Shift+-' },
    'sep',
    { cmd: 'clearFormat',        label: 'Clear formatting',         kbd: 'Ctrl+Shift+X' },
  ]},
  { label: 'Data', id: 'data', items: [
    { cmd: 'sortAsc',            label: 'Sort range A → Z' },
    { cmd: 'sortDesc',           label: 'Sort range Z → A' },
    'sep',
    { cmd: 'toggleFilter',       label: 'Toggle filter',            kbd: 'Ctrl+Shift+L' },
    { cmd: 'createFilter',       label: 'Create filter',            kbd: 'Ctrl+Shift+T' },
    { cmd: 'removeFilter',       label: 'Remove filter' },
    'sep',
    { cmd: 'recalc',             label: 'Recalculate now',          kbd: 'F9' },
    'sep',
    { cmd: 'validation',         label: 'Data validation' },
    { cmd: 'named',              label: 'Named ranges' },
    { cmd: 'protectRange',       label: 'Protect range' },
    { cmd: 'unprotectRange',     label: 'Unprotect range' },
    'sep',
    { cmd: 'trimWhitespace',     label: 'Trim whitespace' },
    { cmd: 'removeDuplicates',   label: 'Remove duplicates',        kbd: 'Ctrl+Alt+D' },
    { cmd: 'splitTextToCols',    label: 'Split text to columns' },
    { cmd: 'randomizeRange',     label: 'Randomize range' },
    'sep',
    { cmd: 'csv',                label: 'Export CSV' },
  ]},
  { label: 'Tools', id: 'tools', items: [
    { cmd: 'openScripts',        label: 'Mono Scripts editor' },
    'sep',
    { cmd: 'shortcutsHelp',      label: 'Keyboard shortcuts',       kbd: 'Ctrl+?' },
  ]},
  { label: 'Extensions', id: 'extensions', items: [
    { cmd: 'openScripts',        label: 'Mono Scripts' },
  ]},
  { label: 'Help', id: 'help', items: [
    { cmd: 'shortcutsHelp',      label: 'Keyboard shortcuts',       kbd: 'Ctrl+?' },
  ]},
];

function menuItemHTML(it) {
  if (it === 'sep') return '<div class="ms-menu-sep"></div>';
  if (it.sub) {
    const inner = it.sub.map((s) => menuItemHTML(s)).join('');
    return `<div class="ms-menu-item-group"><button class="ms-menu-item">${escAttr(it.label)}<span class="ms-menu-arrow">›</span></button><div class="ms-menu-flyout">${inner}</div></div>`;
  }
  const kbd = it.kbd ? `<span class="ms-menu-kbd">${it.kbd}</span>` : '';
  return `<button class="ms-menu-item" data-cmd="${escAttr(it.cmd || '')}">${escAttr(it.label)}${kbd}</button>`;
}

export function menuBarHTML() {
  return MENU_BAR_DEF.map((menu) => {
    const items = menu.items.map(menuItemHTML).join('');
    return `<div class="ms-menu"><button class="ms-menu-btn" data-menu="${escAttr(menu.id)}">${escAttr(menu.label)}</button><div class="ms-menu-pop">${items}</div></div>`;
  }).join('');
}

function closeMenus() {
  document.querySelectorAll('.ms-menu-pop.open').forEach((p) => p.classList.remove('open'));
}

export function wireMenuBar(grid, root) {
  const bar = root.querySelector('#msMenuBar');
  if (!bar) return;
  if (grid.access && !grid.access.canEdit) {
    // grey out every mutating entry (grid.command blocks them anyway)
    bar.querySelectorAll('[data-cmd]').forEach((b) => {
      const cmd = b.dataset.cmd;
      const allowed = RO_CTX.has(cmd) || ['shortcutsHelp', 'zoomIn', 'zoomOut'].includes(cmd);
      if (!allowed || (cmd === 'insertComment' && !grid.access.canComment)) { b.classList.add('is-disabled'); b.style.opacity = '.42'; b.style.pointerEvents = 'none'; }
    });
  }
  bar.querySelectorAll('.ms-menu-btn').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = b.nextElementSibling;
      const open = pop && pop.classList.contains('open');
      closeMenus();
      if (pop && !open) pop.classList.add('open');
    });
  });
  bar.querySelectorAll('[data-cmd]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      grid.command(b.dataset.cmd);
      closeMenus();
    });
  });
  if (!wireMenuBar._docBound) {
    document.addEventListener('click', closeMenus);
    wireMenuBar._docBound = true;
  }
}
