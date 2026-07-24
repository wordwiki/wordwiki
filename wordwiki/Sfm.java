/*
 *
 */
package org.mikmaqonline;

import java.io.*;
import java.util.*;
import org.mikmaqonline.util.*;

/**
 *
 **/
public class Sfm {

  // -------------------------------------------------------------------------
  // --- Low level database support ------------------------------------------
  // -------------------------------------------------------------------------

  /**
   *
   */
  public static class SfmDatabase {
    SfmRecord headerRecord = null;
    SfmRecord[] records = SfmRecord.EmptyArray;

    public void setHeaderRecord (SfmRecord v) { headerRecord = v; }
    public SfmRecord getHeaderRecord () { return headerRecord; }

    public void setRecords (SfmRecord[] v) { records = v; }
    public SfmRecord[] getRecords () { return records; }

    public static SfmDatabase read (String filename, String recordTag,
				    Set interestingFields)
      throws IOException
    {
      return read (filename, recordTag, interestingFields, Integer.MAX_VALUE);
    }

    /**
     *
     */
    public static SfmDatabase read (String filename, String recordTag,
				    Set interestingFields,
				    int stopAfterCount)
      throws IOException
    {
      //Reader in = new BufferedReader (new FileReader (filename));
      Reader in = new BufferedReader 
	(new InputStreamReader (new FileInputStream (filename),
				"ISO-8859-1"));
      SfmDatabase db = SfmDatabase.read (in, recordTag, interestingFields,
					 stopAfterCount);
      in.close ();
      return db;
    }

    public static SfmDatabase read (Reader in, String recordTag,
				    Set interestingFields)
      throws IOException
    { return read (in, recordTag, interestingFields, Integer.MAX_VALUE); }

    /**
     *
     */
    public static SfmDatabase read (Reader in, String recordTag,
				    Set interestingFields,
				    int stopAfterCount)
      throws IOException
    {
      SfmReader sfmReader = new SfmReader (in);

      // --- Read header record
      SfmRecord headerRecord = SfmRecord.read (sfmReader, recordTag,
					       interestingFields);

      // --- Read content records
      ArrayList recordsList = new ArrayList ();
      if (headerRecord != null)
	for (SfmRecord record = SfmRecord.read (sfmReader, recordTag,
						interestingFields); 
	     record != null && stopAfterCount-- > 0;
	     record = SfmRecord.read (sfmReader, recordTag, interestingFields))
	  recordsList.add (record);

      // --- Create database holding records
      SfmDatabase db = new SfmDatabase ();
      db.setRecords ((SfmRecord[])recordsList.toArray (SfmRecord.EmptyArray));
      db.setHeaderRecord (headerRecord);

      return db;
    }

    /**
     *
     */
    public void applySchema (SfmSchema schema)
      throws MmoException
    {
      for (int i=0; i<records.length; i++)
	records[i].applySchema (schema);
    }

    /**
     *
     */
    public void printAsTrees (PrintWriter out)
    {
      for (int i=0; i<records.length; i++)
	{
	  records[i].printAsTree (out);
	  out.println ();
	  out.println ();
	}
    }

    /**
     *
     */
    public void write (String filename)
      throws IOException
    {
      Writer out = new BufferedWriter (new FileWriter (filename));
      write (out);
      out.close ();
    }

    /**
     *
     */
    public void write (Writer out)
      throws IOException
    {
      if (headerRecord != null)
	headerRecord.write (out);
      for (int i=0; i<records.length; i++)
	records[i].write (out);
    }
  }

  /**
   *
   */
  public static class SfmRecord {
    public static SfmRecord[] EmptyArray = new SfmRecord[0];
    SfmField rootField = null;
    SfmField[] fields = SfmField.EmptyArray;

    public void setFields (SfmField[] v) { fields = v; }
    public SfmField[] getFields () { return fields; }

    public SfmField getRootField () { return rootField; }

    public String getField (String fieldName)
    {
      for (int i=0; i<fields.length; i++)
	if (fields[i].name.equals (fieldName))
	  return fields[i].content;
      return null;
    }

    public void setField (SfmField field)
    {
      for (int i=0; i<fields.length; i++)
	if (fields[i].name.equals (field.name))
	  {
	    fields[i] = field;
	    return;
	  }
      addField (field);
    }

    public void setField (String name, String content)
    { setField (new SfmField (name, content)); }

    public void addField (SfmField field)
    {
      SfmField[] newFields = new SfmField[fields.length+1];
      System.arraycopy (fields, 0, newFields, 0, fields.length);
      newFields[fields.length] = field;
      fields = newFields;
    }

    public void addField (String name, String content)
    { addField (new SfmField (name, content)); }

    public void insertField (int index, SfmField field)
    {
      SfmField[] newFields = new SfmField[fields.length+1];
      System.arraycopy (fields, 0, newFields, 0, index);
      newFields[index] = field;
      System.arraycopy (fields, index, newFields, index+1,
			fields.length-index);
      fields = newFields;
    }

    public void insertField (int index, String name, String content)
    { insertField (index, new SfmField (name, content)); }


    public static SfmRecord read (SfmReader in, String recordTag,
				  Set interestingFields)
      throws IOException
    {
      ArrayList fieldsList = new ArrayList ();

      // --- If we are at EOF return null
      String[] field = in.readField ();
      if (field == null) return null;

      // --- Add the first field (usually the record tag except when
      //     reading the file header)
      if (interestingFields == null || 
	  interestingFields.contains (field[0]))
	fieldsList.add (new SfmField (field[0], field[1]));

      // --- Read fields until we hit EOF or a record tag
      field = in.readField ();
      SfmField lastField = null;
      while (field != null && !field[0].equals (recordTag))
	{
	  lastField = new SfmField (field[0], field[1]);
	  if (interestingFields == null || 
	      interestingFields.contains (field[0]))
	    fieldsList.add (lastField);
	  field = in.readField ();
	}

      // --- If the last field had content ending with "\n" strip this
      //     "\n"  (we are trying to get behaviour identical to shoebox)
      if (lastField != null)
	{
	  if (lastField.content != null && lastField.content.endsWith ("\n"))
	    lastField.content = 
	      lastField.content.substring (0, lastField.content.length ()-1);
	}

      // --- If we terminated on hitting a record tag, push it back
      if (field != null)
	in.pushbackField (field);

      // --- Create and return a record containing the fields we have parsed
      SfmRecord record = new SfmRecord ();
      record.setFields ((SfmField[])fieldsList.toArray (SfmField.EmptyArray));

      return record;
    }

    /**
     *
     */
    public void applySchema (SfmSchema schema)
      throws MmoException
    {
      if (fields.length == 0) return;

      // --- Calculate schema for root node
      rootField = fields[0];
      String rootFieldName = rootField.getName ();
      SfmSchemaNode rootFieldSchema = schema.getNode (rootFieldName);
      if (rootFieldSchema == null)
	throw new MmoException 
	  ("unable to find schema for node type '"+rootFieldName+"'");
      rootField.setType (rootFieldSchema);

      // --- Push root node onto fieldStack
      ArrayStack fieldStack = new ArrayStack ();
      fieldStack.push (rootField);
      
      for (int i=1; i<fields.length; i++)
	{
	  // --- Lookup name, schema for field
	  SfmField field = fields[i];
	  String fieldName = field.getName ();
	  SfmSchemaNode fieldSchema = schema.getNode (fieldName);
	  if (fieldSchema == null)
	    throw new MmoException 
	      ("unable to find schema for node type '"+fieldName+"'");
	  field.setType (fieldSchema);
	  
	  // --- Pop node stack until we find an ancestor of this node
	  SfmField ancestorField;
	  do {
	    ancestorField = (SfmField)fieldStack.popOrNull ();
	    if (ancestorField == null)
	      throw new MmoException
		("field '"+fieldName+"' ancestor not found");
	  } while (!ancestorField.getType ().isAncestorOf (fieldSchema));

	  // --- Push ancestor back on stack
	  fieldStack.push (ancestorField);

	  // --- If ancestor is not the direct parent of the field, then
	  //     we need to synthesize missing levels.
	  ArrayList missingLevels = new ArrayList ();
	  for (SfmSchemaNode t = fieldSchema.getParent ();
	       t != ancestorField.getType ();
	       t = t.getParent ())
	    missingLevels.add (t);
	  Collections.reverse (missingLevels);
	  for (Iterator missingIter=missingLevels.iterator ();
	       missingIter.hasNext ();)
	    {
	      SfmSchemaNode missingType = (SfmSchemaNode)missingIter.next ();

	      SfmField synthesizedField = 
		new SfmField (missingType.getTagName (), "");
	      synthesizedField.setType (missingType);
	      ((SfmField)fieldStack.peek ()).addChild (synthesizedField);
	      fieldStack.push (synthesizedField);
	    }

	  // --- Add field to parent
	  ((SfmField)fieldStack.peek ()).addChild (field);

	  // --- Push field on stack
	  fieldStack.push (field);
	}
    }

    /**
     *
     */
    public void printAsTree (PrintWriter out)
    { rootField.printTree (out); }

    /**
     *
     */
    public void write (Writer out)
      throws IOException
    {
      for (int i=0; i<fields.length; i++)
	fields[i].write (out);
      out.write ('\n');
    }
  }

  /**
   *
   */
  public static class SfmField {
    public static SfmField[] EmptyArray = new SfmField[0];
    String name;
    String content;

    SfmSchemaNode type = null;

    SfmField[] children = EmptyArray;
    int childrenCount = 0;

    public SfmField (String _name, String _content)
    {
      name = _name;
      content = _content;
    }

    public String getName () { return name; }
    public String getContent () { return content; }
    public String getTrimmedContent () { return content.trim (); }

    public void setType (SfmSchemaNode v) { type = v; }
    public SfmSchemaNode getType () { return type; }

    public int getChildrenCount () { return childrenCount; }
    public SfmField getChild (int index) { return children[index]; }
    public void addChild (SfmField child)
    { children = (SfmField[])ArrayUtil.set (children, childrenCount++, child);}

    public String getChildContent (String childName)
      throws MmoException
    {
      String result = null;
      for (int i=0; i<childrenCount; i++)
	if (childName.equals (children[i].name))
	  {
	    if (result == null)
                result = "";
            else
                result += "\n";
            result += children[i].content.trim ();
	  }
      return result;
    }

      public String getChildContent_OFF (String childName)
          throws MmoException
          {
              String result = null;
              for (int i=0; i<childrenCount; i++)
                  if (childName.equals (children[i].name))
                  {
                      if (result == null)
                          result = children[i].content.trim ();
                      else
                          throw new MmoException ("duplicate values for singleton field '"+
                                                  childName+"' values='"+result+"', '"+
                                                  children[i].content+"'");
                  }
              return result;
          }
      
    public String getRequiredChildContent (String childName)
      throws MmoException
    {
      String result = getChildContent (childName);
      if (result == null)
	throw new MmoException ("missing required field '"+childName+"'");
      return result;
    }

    public String getOptionalChildContent (String childName,
					   String defaultValue)
      throws MmoException
    {
      String result = getChildContent (childName);
      if (result == null)
	return defaultValue;
      else
	return result;
    }

    public SfmField[] getChildren (String childName)
    {
      // --- If no childname given, return all children
      if (childName == null)
	{
	  SfmField[] result = new SfmField[childrenCount];
	  System.arraycopy (children, 0, result, 0, childrenCount);
	  return result;
	}

      // --- Count children matching child name
      int count = 0;
      for (int i=0; i<childrenCount; i++)
	if (children[i].name.equals (childName))
	  count++;

      // --- Collect children matching child name
      SfmField[] result = new SfmField[count];
      int pos = 0;
      for (int i=0; i<childrenCount; i++)
	if (children[i].name.equals (childName))
	  result[pos++] = children[i];

      return result;
    }

    /**
     *
     */
    public void printTree (PrintWriter out) { printTree (out, ""); }

    private void printTree (PrintWriter out, String indent)
    {
      out.println (type.getPath ()+" '"+getContent ()+"'");
      String childIndent = indent+"  ";
      for (int i=0; i<childrenCount; i++)
	children[i].printTree (out, childIndent);
    }

    /**
     *
     */
    public void write (Writer out)
      throws IOException
    {
      out.write ('\\');
      out.write (name);
      //out.write (':');
      if (content != null && content.length () > 0)
	{
	  if (!content.startsWith ("\n"))
	    out.write (' ');
	  out.write (content);
	}
      //out.write (':');
      out.write ('\n');
    }
  }

  /**
   *
   **/
  public static class SfmReader {
    Reader in;
    boolean gotEof = false;
    boolean pushbackedSlash = false;
    String[] pushbackedField = null;

    public SfmReader (Reader _in)
    {
      in = _in;
    }

    public String[] readField_ ()
      throws IOException
    {
      String[] f = readField ();
      if (f == null)
	System.out.println (f);
      else
	System.out.println (f[0]+":"+f[1]);
      return f;
    }

    /**
     *
     */
    public String[] readField ()
      throws IOException
    {
      int c;

      // --- If we have a pushbacked field, return it
      if (pushbackedField != null)
	{
	  String[] r = pushbackedField;
	  pushbackedField = null;
	  return r;
	}

      // --- If already at eof, tell caller
      if (gotEof)
	return null;

      // --- Expect starting '\' or EOF
      if (!pushbackedSlash)
	{
	  c = in.read ();
	  if (c == -1)
	    {
	      gotEof = true;
	      return null;
	    }
	}
      pushbackedSlash = false;

      // --- Read field name
      StringBuffer fieldNameBuffer = new StringBuffer ();
      c = in.read ();
      while (c != -1 && c != ' ' && c != '\n' && c != '\r' && c != '\\')
	{
	  fieldNameBuffer.append ((char)c);
	  c = in.read ();
	}
      String currentTag = fieldNameBuffer.toString ();

      // --- If we are on a space character, then this is the separation
      //     between the tag and the content, eat it.
      if (c == ' ')
	c = in.read ();

      // --- Read field content
      StringBuffer fieldContentBuffer = new StringBuffer ();
      int lastChar = 0;
      while (c != -1)
	{
	  if (c == '\\' && lastChar == '\n')
	    {
	      pushbackedSlash = true;
	      break;
	    }
	  if (c != '\r')
	    {
	      lastChar = c;
	      fieldContentBuffer.append ((char)c);
	    }
	  c = in.read ();
	}

      // --- Kill any trailing \n or from collected content
      if (fieldContentBuffer.charAt (fieldContentBuffer.length ()-1) == '\n')
	fieldContentBuffer.setLength (fieldContentBuffer.length ()-1);

      String currentContent = fieldContentBuffer.toString ();

      // --- If we have hit EOF now, remember it for next time
      if (c == -1)
	gotEof = true;

      /*
      if (currentTag.equals ("ph")) {
	System.out.println ("got ph "+currentContent);
	for (int i=0; i<currentContent.length (); i++)
	  System.out.println (i+": "+currentContent.charAt(i)+" "+
			      ((int)currentContent.charAt(i)));
      }
      */

      return new String[] {currentTag, currentContent};
    }

    /**
     *
     */
    public void pushbackField (String[] _pushBack)
    {
      if (pushbackedField != null)
	throw new IllegalArgumentException 
	  ("already have a pushed back field");
      pushbackedField = _pushBack;
    }
  }

  // -------------------------------------------------------------------------
  // --- Schema --------------------------------------------------------------
  // -------------------------------------------------------------------------

  /**
   *
   *
   * Note: this class was written while someone was waiting for me, so it
   * a little bit sloppy, especially error handling and recovery. -dz
   */
  public static class SfmSchema {
    static final String SchemaRecordMarker = "+mkr";
    static final String rootTagName = "lx";
    
    SfmDatabase typeDatabase;
    SfmSchemaNode[] nodes;
    SfmSchemaNode root;
    Map schemaNodeLookup = new HashMap ();

    public SfmSchemaNode getRoot () { return root; }
    public SfmSchemaNode getNode (String name)
    { return (SfmSchemaNode)schemaNodeLookup.get (name); }
    
    public int getDepth (String name)
    {
      SfmSchemaNode n = (SfmSchemaNode)schemaNodeLookup.get (name);
      if (n == null) return 0;
      else return n.getDepth ();
    }

    /**
     *
     */
    public static SfmSchema read (String filename)
      throws IOException
    {
      Reader in = new BufferedReader 
	(new InputStreamReader (new FileInputStream (filename),
				"ISO-8859-1"));
      //Reader in = new BufferedReader (new FileReader (filename));
      SfmSchema schema = new SfmSchema ();
      schema.read (in);
      in.close ();
      return schema;
    }

    /**
     *
     */
    public void read (Reader in)
      throws IOException
    {
      // --- Read type database
      typeDatabase = SfmDatabase.read (in, SchemaRecordMarker, null);

      // --- Make schema nodes corresponding to all nodes in type database
      SfmRecord[] records = typeDatabase.getRecords ();
      nodes = new SfmSchemaNode[records.length];
      for (int i=0; i<records.length; i++)
	{
	  SfmRecord record = records[i];
	  SfmSchemaNode schemaNode = new SfmSchemaNode (this, record);
	  String tagName = schemaNode.getTagName ();
	  nodes[i] = schemaNode;
	  schemaNodeLookup.put (tagName, schemaNode);
	  if (tagName.equals (rootTagName)) 
	    root = schemaNode;
	}

      // --- Bind parent/child relationships
      for (int i=0; i<nodes.length; i++)
	{
	  SfmSchemaNode node = nodes[i];

	  String tagName = node.getTagName ();
	  if (tagName == null)
	    System.out.println ("*** missing name for node");
	  if (node != root)
	    {
	      String parentName = node.getParentTagName ();
	      if (parentName == null)
		System.out.println ("*** no parent for node "+tagName);
	      SfmSchemaNode parentNode = getNode (parentName);
	      if (parentNode == null)
		System.out.println ("*** unable to bind parent for "+tagName);
	      node.setParent (parentNode);
	      parentNode.addChild (node);
	    }
	}
    }

    /**
     *
     */
    public void setIsPublic (String[] tagNames)
    {
      for (int i=0; i<tagNames.length; i++)
	{
	  String tagName = tagNames[i];
	  SfmSchemaNode node = getNode (tagName);
	  if (node == null)
	    System.out.println ("*** unable to find node "+tagName);
	  else
	    node.setIsPublic ();
	}
    }

    /**
     *
     */
    public void dump (PrintWriter out, boolean publicOnly)
    { 
      out.println ("<ol>");
      if (root == null)
	out.println ("*** missing root");
      else
	root.dump (out, "", publicOnly);
      out.println ("</ol>");
    } 

//      /**
//       *
//       **/
//      public static void main (String[] args)
//      {
//        String inputSchemaFilename = "mmo.typ";
//        SfmSchema schema = null;

//        // --- Read schema 
//        try {
//  	schema = SfmSchema.read (inputSchemaFilename);
//        } catch (IOException ex) {
//  	System.out.println ("ERROR : "+ex);
//  	System.exit (1);
//        }

//        // --- Dump schema in human-friendly format
//        schema.dump (new PrintWriter (System.out, true), true);
//      }
  }

  /**
   *
   */
  public static class SfmSchemaNode {
    public static final SfmSchemaNode[] EmptyArray = new SfmSchemaNode[0];

    SfmSchema schema;
    SfmRecord record;

    String tagName;
    String parentTagName;
    String name;
    String desc;
    String language;

    boolean isPublic = false;

    int depth = -1;
    String path = null;

    public SfmSchemaNode parent;
    public SfmSchemaNode[] children = SfmSchemaNode.EmptyArray;

    public SfmSchema getSchema () { return schema; }
    public SfmRecord getRecord () { return record; }
    public String getTagName () { return tagName; }
    public String getParentTagName () { return parentTagName; }
    public String getName () { return name; }
    public String getDesc () { return desc; }
    public String getLanguage () { return language; }

    public boolean getIsPublic () { return isPublic; }
    public void setIsPublic () 
    { 
      isPublic = true; 
      if (parent != null) parent.setIsPublic ();
    }

    public int getDepth ()
    {
      if (depth != -1) return depth;
      if (parent == null) return depth=0;
      return depth=parent.getDepth ();
    }

    public boolean isAncestorOf (SfmSchemaNode other)
    {
      SfmSchemaNode otherParent = other.getParent ();
      if (otherParent == null) return false;
      if (otherParent == this) return true;
      return isAncestorOf (otherParent);
    }

    public String getPath ()
    { 
      if (path == null)
	{
	  StringBuffer out = new StringBuffer ();
	  getPath (out); 
	  path = out.toString ();
	}
      return path;
    }

    private void getPath (StringBuffer out)
    {
      if (parent != null)
	parent.getPath (out);
      out.append ("/");
      out.append (tagName);
    }

    public SfmSchemaNode getParent () { return parent; }
    public SfmSchemaNode[] getChildren () { return children; }
    public int getChildrenCount () { return children.length; }
    public SfmSchemaNode getChild (int index) { return children[index]; }
    
    public void addChild (SfmSchemaNode child)
    {
      SfmSchemaNode[] newChildren = new SfmSchemaNode[children.length+1];
      System.arraycopy (children, 0, newChildren, 0, children.length);
      newChildren[children.length] = child;
      children = newChildren;
    }

    public void setParent (SfmSchemaNode _parent)
    { parent = _parent; }

    public SfmSchemaNode (SfmSchema _schema, SfmRecord _record)
    {
      schema = _schema;
      record = _record;

      tagName = record.getField ("+mkr");
      parentTagName = record.getField ("mkrOverThis");

      name = record.getField ("nam");
      desc = record.getField ("desc");
      language = record.getField ("lng");
    }

    /**
     *
     */
    public void dump (PrintWriter out, String indent, boolean publicOnly)
    { 
      if (publicOnly && !isPublic) return;

      out.println ("<li>");
      out.println (indent+"<b>Tag : </b>"+getTagName ()+"<br>");
      out.println (indent+"<b>Name: </b>"+getName ()+"<br>");
      out.println (indent+"<b>Path: </b>"+getPath ()+"<br>");
      out.println (indent+"<b>Desc: </b>"+getDesc ()+"<br>");
      out.println (indent+"<b>Lang: </b>"+getLanguage ()+"<br>");
      out.println ("</li>");
      out.println ("<ol>");
      for (int i=0; i<children.length; i++)
	children[i].dump (out, indent+"  ", publicOnly);
      out.println ("</ol>");
    }
  }

  // -------------------------------------------------------------------------
  // --- Schema processed database -------------------------------------------
  // -------------------------------------------------------------------------
  
  /*
    - read schema
    - read database
    - make new version of each record with fields moved into proper nesting
      structure.
    - dump this
    - build a java datastructure with object corresponding to ...
    - dump this.
    - this loaded java datastructure will be the basis for jsp stuff
    - write page to present a word, present word list, present categories etc.

    - can combine schema processing with initial read if we want to.  Need
      to figure out schema processing algorithm.
    - schema processing is enough of a pain that we want to keep it seperate
      from java object production.


    - so when a new field comes in we want to know if it is under the current
      field.  If no pop fields from stack until we find a field that it is
      under.  Make empty missing levels until we have parent for field. 
      Insert field.

    - this is complicated enough that it is better left to a seperate pass.

    - since we have added schema structure into fields, we can the
      schema processing into Record, and a call on db to call on all records.

   */

  // -------------------------------------------------------------------------
  // --- Mmo -----------------------------------------------------------------
  // -------------------------------------------------------------------------

  public static final String[] publicTagNames = new String []
  {
    "lx",
    "wj",
    "gsf",
    "ws",
    "ph",
    "bw",
    "ps",
    "sn",
    "cf",
    "csf",
    "ge",
    "de",
    "lt",
    "nt",  // XXX put back once data fixed up
    "np",
    "na",
    "pc",
    "xv",
    "xe",
    "xsf",
    "xs",
    "sd",
    "ng",
    "va",
    "vsf",
    "sc",
    "tb",
    "lf",
    "lv",
    "le",
    "lsf",
    "st",
    "dt",
    "nq",  // -- in bad places so will corrupt --
    "tp",  // twitter post (dmm added)
    "so"  // source
  };

  public static final Set publicTagNamesSet = new HashSet ();
  static {
    for (int i=0; i<publicTagNames.length; i++)
      publicTagNamesSet.add (publicTagNames[i]);
  }

/*
  Using, don't show:
  \lx\dt
  \lx\st (set to "done" when ready to post)
  \lx\se\ps\sn\ng
  \lx\se\ps\sn\nq
*/ 

  /**
   *
   **/
  public static void main (String[] args)
    throws MmoException
  {
    PrintWriter out = new PrintWriter (System.out, true);
    
    String inputSchemaFilename = "mmo.typ";
    String dictionaryFilename = "mmo.txt";
    SfmSchema schema = null;
    int readRecords = 10;

    // --- Read schema 
    try {
      schema = SfmSchema.read (inputSchemaFilename);
    } catch (IOException ex) {
      System.out.println ("ERROR : "+ex);
      System.exit (1);
    }

    // --- Set some fields as public
    schema.setIsPublic (publicTagNames);

    // --- Dump schema in human-friendly format
    if (true)
      schema.dump (out, true);

    // --- Read data file
    System.out.println ("Reading dictionary "+dictionaryFilename);
    SfmDatabase db;
    try {
      db = SfmDatabase.read (dictionaryFilename, "lx",
			     publicTagNamesSet, readRecords);
    } catch (IOException ex) {
      throw new MmoException 
	("Got error "+ex.getMessage ()+" reading "+dictionaryFilename, ex);
    }
    System.out.println ("  read "+db.getRecords ().length+" records");
    
    // --- Apply schema to dictionary
    db.applySchema (schema);
    
    // --- Print dictionary in tree format
    if (false)
      db.printAsTrees (out);

    // --- Parse dictionary into Mmo data structure
    Mmo.Dictionary mmo = new Mmo.Dictionary ().parse (db);
    if (false)
      mmo.print (out);
  }
}
