Put voice files in this folder to offer them to players on this
server. They appear in the player's studio next to the built-in
voices, and are not saved to the player's own preset library.

The format is the one the client writes. To make one: tune a voice
in the studio, press Save, then use the studio's "Open folder"
button to find the file and copy it in here.

The filename becomes the voice's id; add a line

    name=Dispatch Radio

to control the label players see. Without it the filename is used.

Only numbers are read from these files. Nothing in them can make a
client load or run anything.